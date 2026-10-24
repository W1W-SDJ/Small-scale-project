'use strict'

// Pet window renderer: drag the pet, keep the area around it click-through, show
// the unread badge + new-item bubble, and open the digest panel.
//
// The sprite is not fixed any more: the main process picks a skin and pushes it in
// as a data: URL, so any imported picture works with no pre-generation step.
//
// Click-through is decided by the sprite's bounding box (see updateHitTest) rather
// than per transparent pixel — per-pixel looked tidier but swallowed presses that
// landed on transparent pixels *inside* the drawing, which is what made the pet
// feel frozen. Sprites are trimmed to their content, so the box is close to the
// silhouette; the bubble strip beside it stays fully click-through.

const img = document.getElementById('pet')
const bubble = document.getElementById('bubble')
const bubbleCount = document.getElementById('bubble-count')
const bubbleTitle = document.getElementById('bubble-title')
const badge = document.getElementById('badge')
const menu = document.getElementById('menu')

let ignoring = false
let dragging = false
let menuOpen = false
let pointerStart = null
let bubbleTimer = null
let menuTimer = null

/** A menu that cannot be dismissed is a trap: a click on a transparent pixel goes
 *  to the desktop and never reaches the page, so nothing closes it. Time it out. */
const MENU_AUTO_CLOSE_MS = 20000
/**
 * Delay before a "gap" verdict turns the window click-through.
 *
 * The hit test flips on every mouse move, and near an outline one pixel of jitter
 * is enough to flip it. If that flip lands between press and release, the press is
 * swallowed by the desktop while the release still arrives — the pet looks frozen
 * exactly where it is drawn. Waiting a beat, and never flipping while a button is
 * held, keeps the press/release pair together.
 */
const GAP_DELAY_MS = 180

let gapTimer = null

function setIgnore(next, reason) {
  if (next === ignoring) return
  ignoring = next
  window.pet.log(`ignore ${next} (${reason})`)
  window.pet.setIgnoreMouse(next)
}

/** Becoming click-through is deferred; becoming interactive is immediate. */
function setIgnoreSoon(next, reason) {
  if (next === false) {
    if (gapTimer) {
      clearTimeout(gapTimer)
      gapTimer = null
    }
    setIgnore(false, reason)
    return
  }
  if (ignoring || gapTimer) return
  gapTimer = setTimeout(() => {
    gapTimer = null
    setIgnore(true, reason)
  }, GAP_DELAY_MS)
}

function updateHitTest(clientX, clientY, buttons) {
  if (dragging) {
    setIgnoreSoon(false, 'dragging')
    return
  }
  if (menuOpen) {
    setIgnoreSoon(false, 'menu-open')
    return
  }
  // Never change the click-through state while a mouse button is down: that is
  // exactly the window in which the press/release pair has to stay together.
  if (buttons) return

  // Interactivity is decided by the sprite's bounding box, not per pixel.
  //
  // Per-pixel hit testing looked nicer on paper but was unreliable in practice: a
  // press on any transparent pixel *inside* the drawing (hair strands, the gap
  // between an arm and the torso, between the legs) went to the desktop, so the
  // window only ever saw the release — the pet appeared frozen exactly where it is
  // drawn. Sprites are trimmed to their content, so the box is very close to the
  // silhouette anyway; the price is that the few transparent holes inside the box
  // no longer pass clicks through, and the win is that clicking the pet always
  // works. The bubble strip to the left stays fully click-through, which is the
  // large transparent area that actually matters.
  const rect = img.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) {
    setIgnoreSoon(false, 'no-rect')
    return
  }
  const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  setIgnoreSoon(!inside, inside ? 'sprite-box' : 'outside')
}

function closeMenu() {
  if (menuTimer) {
    clearTimeout(menuTimer)
    menuTimer = null
  }
  if (!menuOpen) return
  menuOpen = false
  menu.hidden = true
}

window.addEventListener('mousemove', (event) => {
  // event.buttons lets the hit test stay put while a button is held down.
  updateHitTest(event.clientX, event.clientY, event.buttons)
})

// Every press gets a line, including the ones that land outside the image: "the
// pet stopped responding" is almost always "pointerdown never fired", and that is
// only distinguishable from the outside if the presses are recorded.
window.addEventListener(
  'pointerdown',
  (event) => {
    const rect = img.getBoundingClientRect()
    const inImg = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
    window.pet.log(
      `pointerdown b=${event.button} at=${Math.round(event.clientX)},${Math.round(event.clientY)} ` +
        `tgt=${event.target === img ? 'img' : event.target?.id || event.target?.tagName} inImg=${inImg} ignoring=${ignoring}`,
    )
  },
  true,
)

// --- skins ----------------------------------------------------------------

async function applySkinPayload(skin) {
  if (!skin || !skin.dataUrl) return
  img.src = skin.dataUrl
  try {
    await img.decode()
  } catch {
    await new Promise((resolve) => {
      img.onload = resolve
      img.onerror = resolve
    })
  }
  window.pet.log(`skin ${skin.id} ${img.naturalWidth}x${img.naturalHeight}`)
}

// --- dragging and clicking ------------------------------------------------
// Pointer capture makes the window receive the release even if the pointer
// outruns it, which matters because the window is chasing the cursor. A press
// that neither moves nor lingers is a click, and a click opens the digest.
img.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  closeMenu()
  dragging = true
  pointerStart = { x: event.screenX, y: event.screenY, at: Date.now() }
  document.body.classList.add('dragging')
  setIgnore(false, 'drag-start')
  img.setPointerCapture(event.pointerId)
  window.pet.dragStart()
})

function endDrag() {
  if (!dragging) return
  dragging = false
  document.body.classList.remove('dragging')
  window.pet.dragEnd()
}

window.addEventListener('pointerup', (event) => {
  const wasDragging = dragging
  endDrag()
  if (!wasDragging || !pointerStart) {
    window.pet.log(`pointerup ignored wasDragging=${wasDragging} hasStart=${Boolean(pointerStart)}`)
    return
  }
  const moved = Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y)
  const held = Date.now() - pointerStart.at
  pointerStart = null
  window.pet.log(`pointerup moved=${moved.toFixed(1)} held=${held}ms`)
  if (moved < 6 && held < 700) {
    try {
      window.pet.activate()
    } catch (error) {
      window.pet.log(`activate threw ${error.message}`)
    }
  }
})

window.addEventListener('pointercancel', () => {
  window.pet.log(`pointercancel hasStart=${Boolean(pointerStart)} dragging=${dragging}`)
  pointerStart = null
  endDrag()
})

// --- menu -----------------------------------------------------------------
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  menuOpen = true
  menu.hidden = false
  setIgnore(false, 'menu-open')
  if (menuTimer) clearTimeout(menuTimer)
  menuTimer = setTimeout(() => {
    window.pet.log('menu auto-closed after timeout')
    closeMenu()
  }, MENU_AUTO_CLOSE_MS)
})

window.addEventListener(
  'pointerdown',
  (event) => {
    if (menuOpen && !menu.contains(event.target)) closeMenu()
  },
  true,
)

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu()
})

document.getElementById('menu-digest').addEventListener('click', () => {
  closeMenu()
  window.pet.activate()
})

document.getElementById('menu-skin').addEventListener('click', () => {
  closeMenu()
  window.pet.openSkins()
})

document.getElementById('menu-refresh').addEventListener('click', () => {
  closeMenu()
  window.feed.refresh()
})

document.getElementById('menu-quit').addEventListener('click', () => window.pet.quit())

img.addEventListener('dragstart', (event) => event.preventDefault())

// --- digest signals -------------------------------------------------------

function renderBadge(unread) {
  const count = Number(unread) || 0
  if (count <= 0) {
    badge.hidden = true
    return
  }
  badge.hidden = false
  badge.textContent = count > 99 ? '99+' : String(count)
}

function showBubble(payload) {
  const count = Number(payload?.count) || 0
  if (count <= 0) return
  bubbleCount.textContent = count === 1 ? '新内容 1 条' : `新内容 ${count} 条`
  const title = (payload.topTitle || payload.titles?.[0] || '').trim()
  bubbleTitle.textContent = title || '点我查看摘要'
  bubble.classList.add('show')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), Number(payload.durationMs) || 9000)
}

/** The idle float is opt-in because it costs ~18% of a core (see style.css). */
function applyAnimationSetting(snapshot) {
  const on = Boolean(snapshot?.settings?.ui?.petAnimation)
  document.body.classList.toggle('animating', on)
}

function applySnapshot(snapshot) {
  renderBadge(snapshot?.unread)
  applyAnimationSetting(snapshot)
}

window.feed.onSnapshot(applySnapshot)
window.feed.onNew(showBubble)
window.pet.onSkin((skin) => applySkinPayload(skin))

window.feed
  .snapshot()
  .then(applySnapshot)
  .catch(() => {})

// The main process also pushes the skin on did-finish-load, but ask once more so
// a renderer that reloaded on its own still ends up with the right sprite.
window.pet
  .skin()
  .then((skin) => {
    if (skin && skin.dataUrl && img.src !== skin.dataUrl) applySkinPayload(skin)
  })
  .catch(() => {})
