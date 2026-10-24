// Sprite preparation shared by the pet window and the panel (plain browser code).
//
// Two jobs:
//  1. turn an arbitrary picture into a usable sprite: cut the white background
//     away (flood fill from the border), rebuild a soft edge, trim to the
//     creature, so a photo or a screenshot can become a desktop pet;
//  2. build the packed hit-test mask that makes transparent pixels click-through.
//
// Why this lives in the renderer: a canvas that has drawn a file:// image is
// tainted, so getImageData() throws. The main process therefore hands the sprite
// over as a data: URL, which does not taint the canvas — and once the pixels are
// readable, the mask is just one threshold away, with no build step and no
// pre-generated file per skin.
//
// The matte algorithm is the one documented in tools/matte.mjs (strict fill for
// the true outside + a bottom-band fill for the baked contact shadow), ported to
// ImageData so it can run on whatever the user drops in.
;(function () {
  'use strict'

  const MASK_THRESHOLD = 24
  const MATTE = {
    bright: 200, // strict pass: min channel must be >= this
    sat: 26, // strict pass: channel spread must be <= this
    shadowBright: 150,
    shadowSat: 60,
    shadowSeedY: 0.8, // seed the shadow pass below this fraction of height
    shadowLimitY: 0.6, // and never let it climb above this fraction
  }

  /** Fraction of pixels that are already fully transparent. */
  function alphaCoverage(imageData) {
    const data = imageData.data
    let transparent = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent += 1
    return transparent / (data.length / 4)
  }

  function channelStats(data) {
    const count = data.length / 4
    const min = new Uint8Array(count)
    const spread = new Uint8Array(count)
    for (let p = 0; p < count; p++) {
      const i = p * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const max = r > g ? (r > b ? r : b) : g > b ? g : b
      const low = r < g ? (r < b ? r : b) : g < b ? g : b
      min[p] = low
      spread[p] = max - low
    }
    return { min, spread }
  }

  /**
   * Remove a white (or near-white) background and return new ImageData.
   * Everything is reachable-from-the-border based, so bright areas *inside* the
   * subject (eye whites, belly highlights) survive.
   */
  function autoMatte(imageData, options) {
    const opts = { ...MATTE, ...(options || {}) }
    const W = imageData.width
    const H = imageData.height
    const src = imageData.data
    const count = W * H
    const { min, spread } = channelStats(src)

    const bg = new Uint8Array(count) // 0 foreground, 1 strict, 2 shadow pass
    const stack = new Int32Array(count)
    let sp = 0

    const pushIf = (p, accept, mark) => {
      if (bg[p] || !accept(p)) return
      bg[p] = mark
      stack[sp++] = p
    }
    const expand = (accept, minY, mark) => {
      while (sp > 0) {
        const p = stack[--sp]
        const x = p % W
        const y = (p - x) / W
        if (x > 0 && y >= minY) pushIf(p - 1, accept, mark)
        if (x < W - 1 && y >= minY) pushIf(p + 1, accept, mark)
        if (y > minY) pushIf(p - W, accept, mark)
        if (y < H - 1) pushIf(p + W, accept, mark)
      }
    }

    const strict = (p) => min[p] >= opts.bright && spread[p] <= opts.sat
    for (let x = 0; x < W; x++) {
      pushIf(x, strict, 1)
      pushIf((H - 1) * W + x, strict, 1)
    }
    for (let y = 0; y < H; y++) {
      pushIf(y * W, strict, 1)
      pushIf(y * W + W - 1, strict, 1)
    }
    expand(strict, 0, 1)

    // Shadow pass: seeded only from confirmed background near the bottom, and
    // refused above limitY so the pale belly cannot be reached.
    const seedY = Math.floor(H * opts.shadowSeedY)
    const limitY = Math.floor(H * opts.shadowLimitY)
    sp = 0
    for (let y = seedY; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x
        if (bg[p] === 1) stack[sp++] = p
      }
    }
    const loose = (p) => min[p] >= opts.shadowBright && spread[p] <= opts.shadowSat
    expand(loose, limitY, 2)

    // Binary alpha -> one separable box blur for an anti-aliased edge.
    const a0 = new Float32Array(count)
    for (let p = 0; p < count; p++) a0[p] = bg[p] ? 0 : 1
    const tmp = new Float32Array(count)
    const alpha = new Float32Array(count)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0
        let n = 0
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= W) continue
          sum += a0[y * W + nx]
          n++
        }
        tmp[y * W + x] = sum / n
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= H) continue
          sum += tmp[ny * W + x]
          n++
        }
        alpha[y * W + x] = sum / n
      }
    }

    // Faint edge pixels with nothing opaque beside them are leftover shadow
    // gradient, not silhouette.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x
        if (alpha[p] === 0 || alpha[p] >= 0.5) continue
        let strong = 0
        for (let dy = -1; dy <= 1 && !strong; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (a0[ny * W + nx] === 1) {
              strong = 1
              break
            }
          }
        }
        if (!strong) alpha[p] = 0
      }
    }

    const out = new ImageData(W, H)
    const dst = out.data
    const CUT = 0.02
    for (let p = 0; p < count; p++) {
      const i = p * 4
      let a = alpha[p]
      if (a < CUT) a = 0
      let r = src[i]
      let g = src[i + 1]
      let b = src[i + 2]
      if (a > 0 && a < 1) {
        // Un-premultiply against white so no pale fringe survives the cut.
        r = (r - 255 * (1 - a)) / a
        g = (g - 255 * (1 - a)) / a
        b = (b - 255 * (1 - a)) / a
      }
      dst[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
      dst[i + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
      dst[i + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
      dst[i + 3] = Math.round(a * 255)
    }
    return out
  }

  /** Crop to the visible pixels (plus padding) so the pet is not tiny in a big canvas. */
  function trim(imageData, pad) {
    const padding = pad === undefined ? 4 : pad
    const W = imageData.width
    const H = imageData.height
    const data = imageData.data
    let minX = W
    let minY = H
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (data[(y * W + x) * 4 + 3] > 4) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return imageData
    const x0 = Math.max(0, minX - padding)
    const y0 = Math.max(0, minY - padding)
    const x1 = Math.min(W - 1, maxX + padding)
    const y1 = Math.min(H - 1, maxY + padding)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (w === W && h === H) return imageData

    const out = new ImageData(w, h)
    for (let y = 0; y < h; y++) {
      const srcStart = ((y + y0) * W + x0) * 4
      out.data.set(data.subarray(srcStart, srcStart + w * 4), y * w * 4)
    }
    return out
  }

  /**
   * One packed bit per pixel: set where the sprite should catch the mouse.
   *
   * Transparent holes *inside* the silhouette — the gap between an arm and the
   * torso, between hair strands — are filled in. Without that, a press on one of
   * them goes straight through to the desktop and the pet feels unresponsive at a
   * spot that visually belongs to it. Holes that are reachable from the border are
   * the real outside and stay click-through, so the window still does not block
   * the desktop around the sprite.
   */
  function buildMask(imageData, threshold) {
    const limit = threshold === undefined ? MASK_THRESHOLD : threshold
    const width = imageData.width
    const height = imageData.height
    const count = width * height
    const bytes = new Uint8Array(Math.ceil(count / 8))
    const data = imageData.data

    const solid = new Uint8Array(count)
    for (let p = 0; p < count; p++) {
      if (data[p * 4 + 3] >= limit) solid[p] = 1
    }

    // Flood the transparent pixels that are reachable from the border: those are
    // the true outside. Whatever transparent pixel the flood never reaches is a
    // hole inside the subject.
    const outside = new Uint8Array(count)
    const stack = new Int32Array(count)
    let sp = 0
    const seed = (p) => {
      if (outside[p] || solid[p]) return
      outside[p] = 1
      stack[sp++] = p
    }
    for (let x = 0; x < width; x++) {
      seed(x)
      seed((height - 1) * width + x)
    }
    for (let y = 0; y < height; y++) {
      seed(y * width)
      seed(y * width + width - 1)
    }
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % width
      const y = (p - x) / width
      if (x > 0) seed(p - 1)
      if (x < width - 1) seed(p + 1)
      if (y > 0) seed(p - width)
      if (y < height - 1) seed(p + width)
    }

    let filled = 0
    for (let p = 0; p < count; p++) {
      let isSolid = solid[p]
      if (!isSolid && !outside[p]) {
        isSolid = 1 // an enclosed hole: part of the pet for input purposes
        filled++
      }
      if (isSolid) bytes[p >> 3] |= 1 << (7 - (p & 7))
    }
    return { width, height, threshold: limit, bytes, holesFilled: filled }
  }

  /** How much of the image border is still opaque (i.e. background survived). */
  function borderOpaqueRatio(imageData) {
    const { width: W, height: H, data } = imageData
    let opaque = 0
    let total = 0
    const check = (x, y) => {
      total++
      if (data[(y * W + x) * 4 + 3] >= 24) opaque++
    }
    for (let x = 0; x < W; x++) {
      check(x, 0)
      check(x, H - 1)
    }
    for (let y = 1; y < H - 1; y++) {
      check(0, y)
      check(W - 1, y)
    }
    return total ? opaque / total : 0
  }

  /**
   * Region-grow the background away from the border by colour similarity.
   *
   * This is the fallback for art on a *scene* background (sky, clouds, decorations)
   * where the white-background flood leaves most of the picture behind. Each step
   * compares a pixel with the neighbour it was reached from, so gradients are
   * followed instead of jumped; dark pixels and noticeably warm pixels are never
   * eaten, which keeps hair and skin safe.
   */
  function wandMatte(imageData, options) {
    const opts = options || {}
    const tol = opts.tol === undefined ? 12 : opts.tol
    const minV = opts.minV === undefined ? 110 : opts.minV
    const warmGuard = opts.warmGuard === undefined ? 8 : opts.warmGuard
    const W = imageData.width
    const H = imageData.height
    const count = W * H
    const src = imageData.data
    const out = new ImageData(W, H)
    out.data.set(src)

    const gone = new Uint8Array(count)
    const stack = new Int32Array(count)
    let sp = 0

    const value = (p) => {
      const i = p * 4
      const r = src[i]
      const g = src[i + 1]
      const b = src[i + 2]
      return r > g ? (r > b ? r : b) : g > b ? g : b
    }
    const seed = (p) => {
      if (gone[p] || value(p) < minV) return
      gone[p] = 1
      stack[sp++] = p
    }
    const grow = (from, to) => {
      if (to < 0 || to >= count || gone[to]) return
      if (value(to) < minV) return
      const i = to * 4
      if (src[i] - src[i + 2] > warmGuard) return // warm = subject
      const j = from * 4
      const d = Math.max(Math.abs(src[i] - src[j]), Math.abs(src[i + 1] - src[j + 1]), Math.abs(src[i + 2] - src[j + 2]))
      if (d > tol) return
      gone[to] = 1
      stack[sp++] = to
    }

    for (let x = 0; x < W; x++) {
      seed(x)
      seed((H - 1) * W + x)
    }
    for (let y = 0; y < H; y++) {
      seed(y * W)
      seed(y * W + W - 1)
    }
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % W
      const y = (p - x) / W
      if (x > 0) grow(p, p - 1)
      if (x < W - 1) grow(p, p + 1)
      if (y > 0) grow(p, p - W)
      if (y < H - 1) grow(p, p + W)
    }

    for (let p = 0; p < count; p++) {
      if (!gone[p]) continue
      const i = p * 4
      out.data[i] = 0
      out.data[i + 1] = 0
      out.data[i + 2] = 0
      out.data[i + 3] = 0
    }
    return out
  }

  /**
   * Drop opaque islands that are clearly not the subject: background sparkles,
   * hearts and bubbles that a matte could not reach because they are not white.
   * The largest island is the subject; anything else far smaller goes.
   */
  function dropSmallComponents(imageData, options) {
    const opts = options || {}
    const minRatio = opts.minRatio === undefined ? 0.02 : opts.minRatio
    const minArea = opts.minArea === undefined ? 600 : opts.minArea
    const W = imageData.width
    const H = imageData.height
    const count = W * H
    const data = imageData.data
    const labels = new Int32Array(count).fill(-1)
    const stack = new Int32Array(count)
    const areas = []
    const isOpaque = (p) => data[p * 4 + 3] >= 16

    for (let start = 0; start < count; start++) {
      if (labels[start] !== -1 || !isOpaque(start)) continue
      const id = areas.length
      let sp = 0
      let area = 0
      stack[sp++] = start
      labels[start] = id
      while (sp > 0) {
        const p = stack[--sp]
        area++
        const x = p % W
        const y = (p - x) / W
        const push = (q) => {
          if (labels[q] !== -1 || !isOpaque(q)) return
          labels[q] = id
          stack[sp++] = q
        }
        if (x > 0) push(p - 1)
        if (x < W - 1) push(p + 1)
        if (y > 0) push(p - W)
        if (y < H - 1) push(p + W)
      }
      areas.push(area)
    }

    if (areas.length < 2) return { image: imageData, dropped: 0 }
    const largest = Math.max.apply(null, areas)
    const limit = Math.max(minArea, largest * minRatio)
    const keep = new Set()
    for (let id = 0; id < areas.length; id++) if (areas[id] >= limit) keep.add(id)

    const out = new ImageData(W, H)
    out.data.set(data)
    let dropped = 0
    for (let p = 0; p < count; p++) {
      const id = labels[p]
      if (id === -1 || keep.has(id)) continue
      const i = p * 4
      out.data[i] = 0
      out.data[i + 1] = 0
      out.data[i + 2] = 0
      out.data[i + 3] = 0
      dropped++
    }
    return { image: out, dropped, components: areas.length }
  }

  /**
   * Full preparation for an arbitrary dropped picture: pick the right matte for
   * the kind of background it has, remove decorations, trim, and report what
   * happened so the UI can say it out loud.
   */
  function prepareSprite(imageData, options) {
    const opts = options || {}
    if (alphaCoverage(imageData) >= 0.02) {
      // Already cut out (a real transparent PNG): trust it, just tighten the box.
      const trimmed = trim(imageData, opts.pad === undefined ? 4 : opts.pad)
      return { image: trimmed, method: 'as-is', dropped: 0 }
    }

    const white = autoMatte(imageData)
    let result = white
    let method = 'white-background'

    // If the border is still opaque, the picture was not on a white backdrop —
    // a scene background survived the brightness test, so switch strategies.
    if (borderOpaqueRatio(white) > 0.15) {
      result = wandMatte(imageData, opts.wand)
      method = 'scene-background'
    }

    const cleaned = dropSmallComponents(result, opts.components)
    const final = trim(cleaned.image, opts.pad === undefined ? 4 : opts.pad)
    return { image: final, method, dropped: cleaned.dropped }
  }

  window.SkinPrep = {
    alphaCoverage,
    autoMatte,
    wandMatte,
    dropSmallComponents,
    prepareSprite,
    trim,
    buildMask,
    borderOpaqueRatio,
    MASK_THRESHOLD,
  }
})()
