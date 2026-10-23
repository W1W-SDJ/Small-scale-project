'use strict'

// Blob Pet — a transparent desktop pet that reads your sites for you.
//
// Design notes (carried over from v1, they are all hard-won):
//  * The pet window is a frameless transparent rectangle sized to the sprite
//    plus a strip on the left where the notification bubble lives, so the only
//    thing visible is artwork + bubble text.
//  * `focusable: false` maps to WS_EX_NOACTIVATE on Windows: poking the pet
//    never steals focus from whatever you are working in. The digest panel is a
//    separate, focusable window for exactly that reason.
//  * Dragging is driven from this process with the cursor position rather than
//    from renderer deltas, so the pet keeps up with the pointer even when the
//    window moves out from under it, and it is immune to DPI rounding drift.
//  * Regions where the sprite is transparent are made click-through from the
//    renderer via setIgnoreMouseEvents, so the pet never blocks the desktop.
//  * All fetching happens here, never in a renderer: no page content is ever
//    given a chance to run.

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createStore } = require('./core/store')
const { createSkinStore } = require('./core/skins')
const { DEFAULT_CONFIG } = require('./core/config')
const { refresh: runFeedRefresh, addUrl } = require('./core/pipeline')
const { testConnection } = require('./core/llm')

/** On-screen height of the pet itself, in DIP. */
const PET_HEIGHT = 340
/** Widest the sprite may get before it is scaled down to fit beside the bubble. */
const MAX_SPRITE_WIDTH = 560
/** Extra transparent space above the sprite so the idle bob has room. */
const BOB_ROOM = 12
/** Transparent strip on the left of the pet reserved for the bubble. */
const BUBBLE_WIDTH = 208
/** If the first paint never arrives, show the pet anyway after this long. */
const SHOW_FALLBACK_MS = 1500
/** DIP wobble from DIP<->physical rounding that is not worth correcting. */
const SIZE_TOLERANCE = 2
/** How much of the pet must stay inside a display's work area. */
const EDGE_KEEP = 56
const DRAG_INTERVAL_MS = 8
/** Give the desktop a moment to settle before the first fetch. */
const FIRST_REFRESH_DELAY_MS = 5000
/** How long a "new items" bubble stays on screen. */
const BUBBLE_MS = 9000

const SPRITE = path.join(__dirname, 'assets', 'pet.png')

// Keep every byte of app state inside a caller-chosen directory (used when the
// app is launched from a sandbox that only allows writes to one workspace).
if (process.env.PET_USER_DATA) app.setPath('userData', process.env.PET_USER_DATA)

/** Read width/height straight out of the PNG IHDR chunk. */
function pngSize(file) {
  const b = fs.readFileSync(file)
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') throw new Error(`not a PNG: ${file}`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// A desktop pet has no devtools and no console, so anything that goes wrong at
// runtime has to be reconstructable from a log file.
//
// The log is *appended* across launches: rewriting it per session meant every
// restart erased the evidence of whatever had just gone wrong. It is trimmed to
// the last ~1500 lines once it passes 512 KB, so it still cannot grow forever.
const diagFile = () => path.join(app.getPath('userData'), 'pet-diag.log')

function trimDiagLog() {
  try {
    const file = diagFile()
    if (fs.statSync(file).size < 512 * 1024) return
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    fs.writeFileSync(file, lines.slice(-1500).join('\n'))
  } catch {
    /* no log yet, or no permission: nothing to trim */
  }
}

function diag(line) {
  try {
    const file = diagFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never be the thing that breaks the pet */
  }
}

// An uncaught error in a windowed app turns into a modal dialog that leaves the
// process alive with no pet on screen — the worst possible failure mode, and
// exactly what happened once. Log instead, and keep the pet running.
process.on('uncaughtException', (error) => {
  diag(`UNCAUGHT ${error?.stack ?? String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  diag(`UNHANDLED REJECTION ${reason?.stack ?? String(reason)}`)
})

/** Keep a window reachable: never let it leave every display entirely. */
function clampToWorkArea(x, y, w, h) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) }).workArea
  return {
    x: Math.round(Math.min(Math.max(x, area.x - w + EDGE_KEEP), area.x + area.width - EDGE_KEEP)),
    y: Math.round(Math.min(Math.max(y, area.y - h + EDGE_KEEP), area.y + area.height - EDGE_KEEP)),
  }
}

let store = null
let skinStore = null
let config = null
let petWin = null
let panelWin = null
let dragOffset = null
let dragTimer = null
let dragging = false
let resizeRestores = 0
/** Current pet window geometry, which follows the chosen skin. */
let petGeo = { width: 0, height: 0 }
/** Set while we resize the window on purpose, so the size guard stays out of it. */
let resizingForSkin = false
let refreshing = false
let refreshTimer = null
/** A section the panel should jump to once it has actually loaded. */
let pendingPanelSection = null

function defaultPosition(w, h) {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - w - 40, y: area.y + area.height - h - 20 }
}

// --- digest state ---------------------------------------------------------

function snapshot() {
  const digest = store.getDigest()
  return {
    items: store.sorted().slice(0, config.ui?.maxCards || 60),
    unread: store.unreadCount(),
    total: digest.items.length,
    lastRun: digest.lastRun,
    lastError: digest.lastError,
    refreshing,
    settings: publicSettings(),
  }
}

/** Config minus secrets: the renderer learns whether a key exists, never the key. */
function publicSettings() {
  return {
    intervalMinutes: config.intervalMinutes,
    minScore: config.minScore,
    maxAgeDays: config.maxAgeDays,
    maxItemsPerSource: config.maxItemsPerSource,
    skin: config.skin,
    sites: config.sites,
    topics: config.topics,
    extraKeywords: config.extraKeywords,
    ui: config.ui,
    llm: {
      enabled: config.llm.enabled,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      hasKey: Boolean(config.llm.apiKey),
      note: config.llm.note,
    },
  }
}

function sendToPet(channel, payload) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, payload)
}

function sendToPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload)
}

function broadcastSnapshot() {
  const data = snapshot()
  sendToPet('feed:snapshot', data)
  sendToPanel('feed:snapshot', data)
  return data
}

function broadcastStatus(status) {
  sendToPet('feed:status', status)
  sendToPanel('feed:status', status)
}

// --- refresh --------------------------------------------------------------

async function performRefresh(trigger, { notify = true } = {}) {
  if (refreshing) return { skipped: true }
  refreshing = true
  broadcastStatus({ phase: 'start', trigger })
  broadcastSnapshot()

  const beforeIds = new Set(store.items().map((item) => item.id))
  const startedAt = Date.now()
  let result = { added: 0, errors: [], elapsedMs: 0 }

  try {
    result = await runFeedRefresh({
      config,
      store,
      log: (message) => {
        diag(`feed ${message}`)
        broadcastStatus({ phase: 'log', message })
      },
    })
    const added = store.items().filter((item) => !beforeIds.has(item.id))
    diag(`refresh(${trigger}) added=${added.length} errors=${result.errors.length} ms=${Date.now() - startedAt}`)

    if (notify && added.length) {
      const top = store.sorted()[0]
      sendToPet('feed:new', {
        count: added.length,
        titles: added.slice(0, 3).map((item) => item.title),
        topTitle: top ? top.title : '',
        durationMs: BUBBLE_MS,
      })
    }
    broadcastStatus({ phase: 'done', trigger, added: added.length, errors: result.errors.slice(0, 5) })
    broadcastSnapshot()
    return result
  } catch (error) {
    diag(`refresh failed ${error?.stack ?? String(error)}`)
    store.setRun({ lastError: error.message })
    broadcastStatus({ phase: 'done', trigger, added: 0, errors: [error.message] })
    broadcastSnapshot()
    return { added: 0, errors: [error.message], failed: true }
  } finally {
    refreshing = false
    broadcastSnapshot()
  }
}

function scheduleNext(delayMs, { allowShort = false } = {}) {
  if (refreshTimer) clearTimeout(refreshTimer)
  // The 60s floor stops a mis-set interval from hammering small department
  // servers; the very first run after an empty digest is the one exception.
  const delay = allowShort ? Math.max(1000, delayMs) : Math.max(60000, delayMs)
  refreshTimer = setTimeout(() => {
    performRefresh('定时')
      .catch(() => {})
      .finally(() => scheduleNext((Number(config.intervalMinutes) || 60) * 60000))
  }, delay)
  refreshTimer.unref?.()
}

/** First run right away if the digest is empty, else when it is due to go stale. */
function scheduleInitial() {
  const lastRun = store.getDigest().lastRun
  const interval = (Number(config.intervalMinutes) || 60) * 60000
  if (!store.items().length) {
    scheduleNext(FIRST_REFRESH_DELAY_MS, { allowShort: true })
    return
  }
  const age = lastRun ? Date.now() - Date.parse(lastRun) : Number.POSITIVE_INFINITY
  scheduleNext(Number.isFinite(age) ? Math.max(60000, interval - age) : FIRST_REFRESH_DELAY_MS, {
    allowShort: !Number.isFinite(age),
  })
}

// --- pet window -----------------------------------------------------------

/**
 * Window geometry for a sprite: the pet is PET_HEIGHT tall, the sprite keeps its
 * aspect ratio, and the window is widened by BUBBLE_WIDTH on the left for the
 * notification bubble. A very wide sprite is scaled down so it cannot sprawl
 * across the desktop.
 */
function geometryForSprite(sprite) {
  let spriteHeight = PET_HEIGHT
  let spriteWidth = Math.round(sprite.width * (spriteHeight / sprite.height))
  if (spriteWidth > MAX_SPRITE_WIDTH) {
    spriteHeight = Math.round(spriteHeight * (MAX_SPRITE_WIDTH / spriteWidth))
    spriteWidth = MAX_SPRITE_WIDTH
  }
  return { width: spriteWidth + BUBBLE_WIDTH, height: spriteHeight + BOB_ROOM }
}

function currentSkin() {
  return skinStore.resolve(config.skin)
}

function sendSkinToPet(skin) {
  if (!petWin || petWin.isDestroyed() || !skin) return
  try {
    petWin.webContents.send('pet:skin', {
      id: skin.id,
      name: skin.name,
      width: skin.width,
      height: skin.height,
      dataUrl: skinStore.dataUrl(skin),
    })
  } catch (error) {
    diag(`skin send failed ${error.message}`)
  }
}

/**
 * Swap the sprite: resize the window to the new aspect ratio, keeping the
 * sprite's bottom-right corner pinned so the pet does not appear to jump, then
 * push the new bitmap and let the renderer rebuild its hit-test mask.
 */
function applySkin(id, { persist = true } = {}) {
  const skin = skinStore.resolve(id)
  if (!skin) return null

  if (persist && config.skin !== skin.id) {
    config.skin = skin.id
    store.writeConfig(config)
  }

  petGeo = geometryForSprite({ width: skin.width, height: skin.height })
  if (petWin && !petWin.isDestroyed()) {
    const b = petWin.getBounds()
    const pos = clampToWorkArea(b.x + b.width - petGeo.width, b.y + b.height - petGeo.height, petGeo.width, petGeo.height)
    resizingForSkin = true
    petWin.setBounds({ x: pos.x, y: pos.y, width: petGeo.width, height: petGeo.height })
    resizingForSkin = false
    store.writeState({ position: pos, width: petGeo.width })
    sendSkinToPet(skin)
  }
  diag(`skin applied ${skin.id} sprite=${skin.width}x${skin.height} window=${petGeo.width}x${petGeo.height}`)
  return skin
}

function createWindow() {
  const skin = currentSkin()
  const sprite = skin ? { width: skin.width, height: skin.height } : pngSize(SPRITE)
  petGeo = geometryForSprite(sprite)
  const width = petGeo.width
  const height = petGeo.height

  const saved = store.readState()
  // A saved spot from a previous build (or another skin) with a different window
  // width would put the sprite off-centre, so only trust it when it still matches.
  const savedPos = saved.position
  const usable = savedPos && saved.width === width && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)
  const start = usable ? { x: savedPos.x, y: savedPos.y } : defaultPosition(width, height)
  const pos = clampToWorkArea(start.x, start.y, width, height)

  petWin = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // 'screen-saver' keeps the pet above ordinary always-on-top windows.
  petWin.setAlwaysOnTop(true, 'screen-saver')

  // Diagnostics must never be able to kill the pet: everything that computes a
  // value for the log stays inside the try. (An earlier revision called a
  // non-existent screen API right here and took the whole app down with it.)
  try {
    diag(
      `create sprite=${sprite.width}x${sprite.height} PET_HEIGHT=${PET_HEIGHT} ` +
        `requested=${width}x${height} DIP at ${pos.x},${pos.y} ` +
        `-> bounds=${JSON.stringify(petWin.getBounds())} ` +
        `scale=${screen.getDisplayMatching(petWin.getBounds()).scaleFactor}`,
    )
  } catch (error) {
    diag(`create diagnostics failed ${error?.stack ?? String(error)}`)
  }

  // Nothing in this app resizes the pet window, so a resize here means something
  // outside did it. Refuse the interactive ones, and put the size back if it
  // changed anyway — but ignore the ±1-2 DIP wobble that DIP<->physical rounding
  // produces on a fractional scale factor, otherwise the correction itself turns
  // into a resize storm.
  petWin.on('will-resize', (event, newBounds) => {
    diag(`will-resize -> ${newBounds.width}x${newBounds.height} (refused)`)
    event.preventDefault()
  })
  petWin.on('resize', () => {
    // Never touch the geometry mid-drag: resizing the window under a captured
    // pointer cancels the capture, which ends the drag early. The correction is
    // deferred to drag-end instead. Skin swaps resize on purpose, so skip too.
    if (dragging || resizingForSkin) return
    const b = petWin.getBounds()
    if (Math.abs(b.width - petGeo.width) <= SIZE_TOLERANCE && Math.abs(b.height - petGeo.height) <= SIZE_TOLERANCE) return
    resizeRestores += 1
    petWin.setBounds({ x: b.x, y: b.y, width: petGeo.width, height: petGeo.height })
  })
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Show exactly once, whichever comes first. Waiting only for 'ready-to-show'
  // is a trap: that event needs a first paint, so if the renderer never paints
  // the window stays hidden forever while the process keeps running.
  let shown = false
  const showPet = (reason) => {
    if (shown) return
    shown = true
    const b = petWin.getBounds()
    if (b.width !== petGeo.width || b.height !== petGeo.height) {
      diag(`shown at wrong size ${b.width}x${b.height} (restoring ${petGeo.width}x${petGeo.height})`)
      petWin.setBounds({ x: b.x, y: b.y, width: petGeo.width, height: petGeo.height })
    }
    petWin.showInactive()
    diag(`shown via ${reason} bounds=${JSON.stringify(petWin.getBounds())}`)
  }
  const showTimer = setTimeout(() => showPet('fallback timer'), SHOW_FALLBACK_MS)
  petWin.once('ready-to-show', () => {
    clearTimeout(showTimer)
    showPet('ready-to-show')
  })

  petWin.webContents.on('did-finish-load', () => {
    diag('did-finish-load')
    sendSkinToPet(currentSkin())
    broadcastSnapshot()
  })
  petWin.webContents.on('did-fail-load', (_event, code, description, url) => {
    diag(`did-fail-load ${code} ${description} ${url}`)
  })
  petWin.webContents.on('render-process-gone', (_event, details) => {
    diag(`render-process-gone ${JSON.stringify(details)}`)
  })
  petWin.webContents.on('unresponsive', () => diag('renderer unresponsive'))

  petWin.loadFile(path.join(__dirname, 'index.html'))
  petWin.on('closed', () => {
    petWin = null
  })

  // Persist the starting spot immediately, so the state file always reflects
  // where the pet actually is rather than only after the first drag.
  store.writeState({ position: pos, width })
}

// --- digest panel ---------------------------------------------------------

function panelSize() {
  const width = Math.max(340, Math.min(520, Number(config.ui?.panelWidth) || 392))
  const height = Math.max(420, Math.min(760, Number(config.ui?.panelHeight) || 560))
  return { width, height }
}

/** Sit beside the pet, on whichever side has room, bottoms aligned. */
function panelBounds() {
  const { width, height } = panelSize()
  const pet = petWin && !petWin.isDestroyed() ? petWin.getBounds() : null
  const area = screen.getDisplayNearestPoint(
    pet ? { x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 } : screen.getCursorScreenPoint(),
  ).workArea

  let x
  let y
  if (pet) {
    x = pet.x - width - 10
    if (x < area.x + 8) x = pet.x + pet.width + 10
    y = pet.y + pet.height - height
  } else {
    x = area.x + area.width - width - 24
    y = area.y + area.height - height - 24
  }

  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - width - 8)
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8)
  return { x: Math.round(x), y: Math.round(y), width, height }
}

/**
 * The panel is created on demand and destroyed on close.
 *
 * Hiding and re-showing it looked cheaper, but a transparent frameless window
 * that has been hidden does not repaint reliably when shown again: Electron
 * reports `isVisible() === true` while the window paints nothing, so the panel
 * is on screen in every sense except being visible. Recreating it guarantees a
 * fresh first paint, and it also drops the idle renderer while the panel is shut.
 */
function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) return panelWin

  let revealed = false
  const reveal = (reason) => {
    if (revealed || !panelWin || panelWin.isDestroyed()) return
    revealed = true
    const bounds = panelBounds()
    panelWin.setBounds(bounds)
    panelWin.show()
    panelWin.focus()
    sendToPanel('feed:snapshot', snapshot())
    diag(`panel revealed via ${reason} bounds=${JSON.stringify(bounds)} visible=${panelWin.isVisible()}`)
  }

  panelWin = new BrowserWindow({
    ...panelBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '资讯摘要',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  panelWin.setAlwaysOnTop(true, 'screen-saver')
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  panelWin.loadFile(path.join(__dirname, 'panel.html'))

  // Same trap as the pet window: waiting only for 'ready-to-show' means a window
  // that never paints is never shown at all. Fall back to showing it anyway.
  const showTimer = setTimeout(() => reveal('fallback timer'), SHOW_FALLBACK_MS)
  panelWin.once('ready-to-show', () => {
    clearTimeout(showTimer)
    reveal('ready-to-show')
  })
  panelWin.on('closed', () => {
    clearTimeout(showTimer)
    panelWin = null
    diag('panel window closed')
  })
  panelWin.webContents.on('did-fail-load', (_event, code, description, url) => {
    diag(`panel did-fail-load ${code} ${description} ${url}`)
  })
  panelWin.webContents.on('render-process-gone', (_event, details) => {
    diag(`panel render-process-gone ${JSON.stringify(details)}`)
  })
  panelWin.webContents.on('did-finish-load', () => {
    sendToPanel('feed:snapshot', snapshot())
    flushPanelSection()
  })
  panelWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  return panelWin
}

/**
 * Ask the panel to open a specific section (currently only 'skins').
 *
 * The message has to survive the panel not being loaded yet: a freshly created
 * window drops IPC sent before its renderer subscribes, which made "换皮肤"
 * silently open the digest list instead. So remember the request and deliver it
 * on did-finish-load as well as immediately.
 */
function requestPanelSection(section) {
  pendingPanelSection = section
  if (panelWin && !panelWin.isDestroyed() && !panelWin.webContents.isLoading()) {
    sendToPanel('panel:section', { section })
    pendingPanelSection = null
  }
}

function flushPanelSection() {
  if (!pendingPanelSection) return
  sendToPanel('panel:section', { section: pendingPanelSection })
  pendingPanelSection = null
}

function destroyPanel() {
  if (!panelWin) return
  const win = panelWin
  panelWin = null
  pendingPanelSection = null
  if (!win.isDestroyed()) win.destroy()
}

function openExternal(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    shell.openExternal(parsed.href)
    return true
  } catch {
    return false
  }
}

function togglePanel(force) {
  try {
    const existing = panelWin && !panelWin.isDestroyed() ? panelWin : null
    const visible = Boolean(existing && existing.isVisible())
    const show = typeof force === 'boolean' ? force : !visible
    if (!show) {
      destroyPanel()
      diag('panel closed by toggle')
      return false
    }
    if (existing) {
      // Already on screen: reposition next to the pet and take focus. If it is
      // still loading, its ready-to-show handler reveals it.
      if (existing.isVisible()) {
        existing.setBounds(panelBounds())
        existing.show()
        existing.focus()
        sendToPanel('feed:snapshot', snapshot())
      }
      return true
    }
    createPanelWindow()
    return true
  } catch (error) {
    diag(`togglePanel failed ${error?.stack ?? String(error)}`)
    return false
  }
}

// --- settings -------------------------------------------------------------

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function sanitizeSites(sites) {
  if (!Array.isArray(sites)) return config.sites
  return sites
    .filter((site) => site && typeof site.url === 'string' && /^https?:\/\/[^\s/]+/i.test(site.url))
    .map((site, index) => {
      let host = String(site.url)
      try {
        host = new URL(site.url).host
      } catch {
        /* keep the raw string as a fallback label */
      }
      return {
        id: String(site.id || `custom-${Date.now()}-${index}`),
        name: String(site.name || host).slice(0, 40),
        url: String(site.url),
        enabled: site.enabled !== false,
        note: String(site.note || '').slice(0, 80),
      }
    })
}

function sanitizeTopics(topics) {
  if (!Array.isArray(topics)) return config.topics
  return topics.map((topic) => ({
    id: String(topic.id),
    name: String(topic.name || topic.id).slice(0, 20),
    color: String(topic.color || '#8ab4f8'),
    keywords: Array.isArray(topic.keywords) ? topic.keywords.map((word) => String(word).trim()).filter(Boolean) : [],
    enabled: topic.enabled !== false,
  }))
}

function applySettings(patch = {}) {
  const next = JSON.parse(JSON.stringify(config))
  if (patch.intervalMinutes !== undefined) next.intervalMinutes = clampNumber(patch.intervalMinutes, 1, 1440, 60)
  if (patch.minScore !== undefined) next.minScore = clampNumber(patch.minScore, 1, 40, 3)
  if (patch.maxItemsPerSource !== undefined) next.maxItemsPerSource = clampNumber(patch.maxItemsPerSource, 1, 20, 8)
  if (patch.sites !== undefined) next.sites = sanitizeSites(patch.sites)
  if (patch.topics !== undefined) next.topics = sanitizeTopics(patch.topics)
  if (patch.extraKeywords !== undefined) {
    next.extraKeywords = (Array.isArray(patch.extraKeywords) ? patch.extraKeywords : String(patch.extraKeywords).split(/[,，\n]/))
      .map((word) => String(word).trim())
      .filter(Boolean)
      .slice(0, 40)
  }
  if (patch.llm !== undefined) {
    const llm = patch.llm || {}
    next.llm = {
      ...next.llm,
      enabled: llm.enabled !== undefined ? Boolean(llm.enabled) : next.llm.enabled,
      baseUrl: llm.baseUrl !== undefined ? String(llm.baseUrl).trim() : next.llm.baseUrl,
      model: llm.model !== undefined ? String(llm.model).trim() : next.llm.model,
    }
    if (llm.apiKey) next.llm.apiKey = String(llm.apiKey).trim()
    if (llm.clearKey) next.llm.apiKey = ''
  }
  config = next
  store.writeConfig(config)
  scheduleNext((Number(config.intervalMinutes) || 60) * 60000)
  return config
}

// --- ipc ------------------------------------------------------------------

ipcMain.on('pet:drag-start', () => {
  if (!petWin) return
  diag(`drag-start bounds=${JSON.stringify(petWin.getBounds())}`)
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = petWin.getPosition()
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
  dragging = true
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(() => {
    if (!petWin || !dragOffset) return
    const p = screen.getCursorScreenPoint()
    // Integer DIP only: setPosition rejects fractional arguments ("conversion
    // failure"), which silently skipped frames and made the pet lag the cursor.
    petWin.setPosition(Math.round(p.x - dragOffset.x), Math.round(p.y - dragOffset.y), false)
  }, DRAG_INTERVAL_MS)
})

ipcMain.on('pet:drag-end', () => {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  dragOffset = null
  dragging = false
  if (petWin) {
    // One size correction, now that the pointer is free again.
    const b = petWin.getBounds()
    if (Math.abs(b.width - petGeo.width) > SIZE_TOLERANCE || Math.abs(b.height - petGeo.height) > SIZE_TOLERANCE) {
      resizeRestores += 1
      petWin.setBounds({ x: b.x, y: b.y, width: petGeo.width, height: petGeo.height })
    }
    const [x, y] = petWin.getPosition()
    diag(`drag-end bounds=${JSON.stringify(petWin.getBounds())} sizeCorrections=${resizeRestores}`)
    resizeRestores = 0
    store.writeState({ position: { x, y } })
    // The panel follows the pet so it never ends up stranded off-screen.
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) panelWin.setBounds(panelBounds())
  }
})

ipcMain.on('pet:set-ignore-mouse', (_event, ignore) => {
  if (petWin) petWin.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
})

ipcMain.on('pet:activate', () => {
  diag('activate received from renderer')
  togglePanel()
})

/** "换皮肤" from the pet's right-click menu: open the panel straight onto skins. */
ipcMain.on('pet:open-skins', () => {
  togglePanel(true)
  requestPanelSection('skins')
})

ipcMain.on('app:log', (_event, message) => diag(`renderer: ${message}`))

ipcMain.on('pet:quit', () => app.quit())

ipcMain.on('panel:close', (event) => {
  let from = '?'
  try {
    from = event.sender.getURL()
  } catch {
    /* a destroyed sender has no URL left */
  }
  diag(`panel close requested from ${from}`)
  destroyPanel()
})

ipcMain.handle('feed:snapshot', () => snapshot())

ipcMain.handle('feed:refresh', async () => {
  const result = await performRefresh('手动')
  return { ...result, snapshot: snapshot() }
})

ipcMain.handle('feed:add-url', async (_event, url) => {
  const raw = String(url || '').trim()
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: '请粘贴以 http:// 或 https:// 开头的链接' }
  try {
    const item = await addUrl({ url: raw, config, store })
    broadcastSnapshot()
    sendToPet('feed:new', { count: 1, titles: [item.title], topTitle: item.title, durationMs: BUBBLE_MS })
    return { ok: true, item }
  } catch (error) {
    diag(`add-url failed ${error.message}`)
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('feed:open', (_event, url) => {
  const opened = openExternal(url)
  diag(`open external ok=${opened} url=${String(url).slice(0, 120)}`)
  return opened
})

ipcMain.handle('feed:mark-read', (_event, ids) => {
  const wanted = Array.isArray(ids) ? ids : []
  const before = store.unreadCount()
  store.markRead(wanted)
  diag(`mark-read requested=${wanted.length} unread ${before}->${store.unreadCount()}`)
  return broadcastSnapshot()
})

ipcMain.handle('feed:remove', (_event, id) => {
  store.remove(String(id))
  return broadcastSnapshot()
})

ipcMain.handle('settings:save', (_event, patch) => {
  const saved = applySettings(patch)
  diag(`settings saved interval=${saved.intervalMinutes} sites=${saved.sites.length} topics=${saved.topics.length}`)
  return broadcastSnapshot()
})

ipcMain.handle('settings:reset', () => {
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  config.llm.apiKey = ''
  store.writeConfig(config)
  scheduleNext((Number(config.intervalMinutes) || 60) * 60000)
  diag('settings reset to defaults')
  return broadcastSnapshot()
})

ipcMain.handle('settings:test-llm', async (_event, patch) => {
  // Test the values currently typed in the settings form, not the saved ones —
  // otherwise a freshly pasted key could never be tried before saving.
  const candidate = { ...config.llm, ...(patch || {}) }
  if (patch?.clearKey) candidate.apiKey = ''
  const result = await testConnection(candidate)
  diag(`llm test ok=${result.ok} ${String(result.message).slice(0, 80)}`)
  return result
})

ipcMain.handle('feed:clear', () => {
  store.clear()
  return broadcastSnapshot()
})

// --- skins ----------------------------------------------------------------

function skinSummary() {
  return skinStore.list().map((skin) => ({
    id: skin.id,
    name: skin.name,
    source: skin.source,
    width: skin.width,
    height: skin.height,
    // The panel is a file:// page, so a plain file URL is a safe thumbnail source.
    url: pathToFileURL(skin.file).href,
  }))
}

function skinState() {
  const active = currentSkin()
  return { current: active ? active.id : null, skins: skinSummary() }
}

ipcMain.handle('skin:list', () => skinState())

ipcMain.handle('skin:current', () => {
  const skin = currentSkin()
  if (!skin) return null
  try {
    return { id: skin.id, name: skin.name, width: skin.width, height: skin.height, dataUrl: skinStore.dataUrl(skin) }
  } catch (error) {
    diag(`skin:current failed ${error.message}`)
    return null
  }
})

ipcMain.handle('skin:apply', (_event, id) => {
  const skin = applySkin(String(id))
  if (!skin) return { ok: false, error: '找不到这个皮肤', ...skinState() }
  return { ok: true, ...skinState() }
})

ipcMain.handle('skin:import', (_event, payload) => {
  try {
    const raw = String(payload?.dataUrl || '')
    const base64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, '')
    if (!base64) throw new Error('没有收到图片数据')
    const buffer = Buffer.from(base64, 'base64')
    // Import always stores a *prepared* sprite (matte + trimmed) produced by the
    // renderer, so keep this strict: a stray JPEG here would break the pet.
    const skin = skinStore.importBuffer(buffer, payload?.name)
    applySkin(skin.id, { persist: true })
    diag(`skin imported ${skin.id} ${skin.width}x${skin.height}`)
    return { ok: true, imported: skin.id, ...skinState() }
  } catch (error) {
    diag(`skin import failed ${error.message}`)
    return { ok: false, error: error.message, ...skinState() }
  }
})

ipcMain.handle('skin:remove', (_event, id) => {
  try {
    const wasActive = currentSkin()?.id === String(id)
    skinStore.remove(String(id))
    if (wasActive) applySkin(skinStore.list()[0]?.id)
    return { ok: true, ...skinState() }
  } catch (error) {
    return { ok: false, error: error.message, ...skinState() }
  }
})

// --- lifecycle ------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch is how you poke a running pet from outside: with --skins it
  // opens straight onto the skin picker (usable from a desktop shortcut), plain
  // otherwise.
  app.on('second-instance', (_event, argv) => {
    togglePanel(true)
    if (Array.isArray(argv) && argv.includes('--skins')) requestPanelSection('skins')
  })

  app.whenReady()
    .then(() => {
      store = createStore(app.getPath('userData'))
      skinStore = createSkinStore(path.join(app.getPath('userData'), 'skins'))
      config = store.readConfig(DEFAULT_CONFIG)
      // A skin id that no longer exists (deleted folder, hand-edited config) must
      // not leave the pet with no sprite at all.
      const resolved = skinStore.resolve(config.skin)
      if (resolved && resolved.id !== config.skin) config.skin = resolved.id
      store.writeConfig(config)
      trimDiagLog()
      diag(`--- session start pid=${process.pid} electron=${process.versions.electron} appPath=${app.getAppPath()}`)
      diag(
        `ready electron=${process.versions.electron} appPath=${app.getAppPath()} ` +
          `userData=${app.getPath('userData')} sites=${config.sites.filter((s) => s.enabled).length} ` +
          `items=${store.items().length} lastRun=${store.getDigest().lastRun}`,
      )
      createWindow()
      scheduleInitial()
      diag('startup complete')
    })
    .catch((error) => diag(`whenReady/createWindow failed ${error?.stack ?? String(error)}`))

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })
}
