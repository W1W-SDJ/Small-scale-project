'use strict'

// Pet window renderer: drag the pet, keep the transparent parts click-through,
// show the unread badge + new-item bubble, and open the digest panel.
//
// The sprite is not fixed any more: the main process picks a skin and pushes it
// in as a data: URL. A data: URL does not taint the canvas, so the hit-test mask
// is computed here from the actual pixels — which is what lets an arbitrary
// imported picture work with no pre-generation step.

const img = document.getElementById('pet')
const bubble = document.getElementById('bubble')
const bubbleCount = document.getElementById('bubble-count')
const bubbleTitle = document.getElementById('bubble-title')
const badge = document.getElementById('badge')
const menu = document.getElementById('menu')

/** Packed 1-bit-per-pixel hit mask for the current sprite. */
let MASK = null
let SOLID = null

function solidAt(x, y) {
  // No mask (build failed, or still loading) means "the whole sprite is solid":
  // the pet stays usable, it just stops passing clicks through.
  if (!SOLID) return true
  if (x < 0 || y < 0 || x >= MASK.width || y >= MASK.height) return false
  const p = y * MASK.width + x
  return (SOLID[p >> 3] & (1 << (7 - (p & 7)))) !== 0
}

let ignoring = false
let dragging = false
let menuOpen = false
let pointerStart = null
let bubbleTimer = null

function setIgnore(next) {
  if (next === ignoring) return
  ignoring = next
  window.pet.setIgnoreMouse(next)
}

function updateHitTest(clientX, clientY) {
  if (dragging || menuOpen) {
    setIgnore(false)
    return
  }
  if (!MASK) {
    setIgnore(false)
    return
  }
  // getBoundingClientRect reflects the bob animation, so mapping through it
  // keeps the mask aligned with what is actually on screen.
  const rect = img.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const x = Math.floor(((clientX - rect.left) / rect.width) * MASK.width)
  const y = Math.floor(((clientY - rect.top) / rect.height) * MASK.height)
  setIgnore(!solidAt(x, y))
}

function closeMenu() {
  if (!menuOpen) return
  menuOpen = false
  menu.hidden = true
}

window.addEventListener('mousemove', (event) => {
  updateHitTest(event.clientX, event.clientY)
})

// --- skins ----------------------------------------------------------------

function decodeMask(width, height, bytes) {
  return { width, height, bytes }
}

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

  try {
    const width = img.naturalWidth
    const height = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(img, 0, 0)
    const pixels = context.getImageData(0, 0, width, height)
    const mask = window.SkinPrep.buildMask(pixels)
    MASK = decodeMask(mask.width, mask.height, mask.bytes)
    SOLID = mask.bytes
    window.pet.log(`skin ${skin.id} mask ${mask.width}x${mask.height}`)
  } catch (error) {
    MASK = null
    SOLID = null
    window.pet.log(`mask build failed ${error.message}`)
  }
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
  setIgnore(false)
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
  pointerStart = null
  endDrag()
})

// --- menu -----------------------------------------------------------------
window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (dragging) return
  menuOpen = true
  menu.hidden = false
  setIgnore(false)
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

window.feed.onSnapshot((snapshot) => renderBadge(snapshot?.unread))
window.feed.onNew(showBubble)
window.pet.onSkin((skin) => applySkinPayload(skin))

window.feed
  .snapshot()
  .then((snapshot) => renderBadge(snapshot?.unread))
  .catch(() => {})

// The main process also pushes the skin on did-finish-load, but ask once more so
// a renderer that reloaded on its own still ends up with the right sprite.
window.pet
  .skin()
  .then((skin) => {
    if (skin && skin.dataUrl && img.src !== skin.dataUrl) applySkinPayload(skin)
  })
  .catch(() => {})
