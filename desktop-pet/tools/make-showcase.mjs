// Compose a clean README showcase image from a skin sprite.
//
//   node tools/make-showcase.mjs [sprite.png] [out.png]
//
// Why not a screenshot: a real desktop capture carries whatever the author had on
// screen (wallpaper, chat windows). This composes the *actual* sprite — so the
// character is genuinely the one that ships — onto a neutral background, with a
// wireframe hint of the digest panel beside it. Everything is drawn with the PNG
// buffer directly: no canvas, no image library, no text rendering.
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const spritePath = process.argv[2] ?? 'assets/skins/whale-musume/pet.png'
const outPath = process.argv[3] ?? 'docs/showcase.png'

const W = 1200
const H = 675
const SS = 2 // supersample factor for smooth edges
const CW = W * SS
const CH = H * SS

const out = new PNG({ width: CW, height: CH })

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Alpha-blend one pixel (0..1 alpha) onto the canvas. */
function blend(x, y, r, g, b, a) {
  if (a <= 0) return
  if (x < 0 || y < 0 || x >= CW || y >= CH) return
  const i = (y * CW + x) * 4
  const dstA = out.data[i + 3] / 255
  const srcA = a
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return
  out.data[i] = Math.round((r * srcA + out.data[i] * dstA * (1 - srcA)) / outA)
  out.data[i + 1] = Math.round((g * srcA + out.data[i + 1] * dstA * (1 - srcA)) / outA)
  out.data[i + 2] = Math.round((b * srcA + out.data[i + 2] * dstA * (1 - srcA)) / outA)
  out.data[i + 3] = Math.round(outA * 255)
}

// ---- background: cool gradient + soft glow behind the pet -----------------
const glowX = 800 * SS
const glowY = 380 * SS
for (let y = 0; y < CH; y++) {
  const t = y / CH
  // #F3F8FE -> #FFFFFF
  const r = Math.round(243 + (255 - 243) * t)
  const g = Math.round(248 + (255 - 248) * t)
  const b = 254
  for (let x = 0; x < CW; x++) {
    const dx = (x - glowX) / (430 * SS)
    const dy = (y - glowY) / (330 * SS)
    const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy))
    const k = smooth(0, 1, glow) * 0.55
    blend(x, y, Math.round(r * (1 - k) + 214 * k), Math.round(g * (1 - k) + 232 * k), Math.round(b * (1 - k) + 251 * k), 1)
  }
}

// ---- helpers -------------------------------------------------------------
function roundRect(x0, y0, w, h, radius, r, g, b, alpha) {
  const cx = (x0 + w / 2) * SS
  const cy = (y0 + h / 2) * SS
  const hw = (w / 2) * SS
  const hh = (h / 2) * SS
  const rad = radius * SS
  for (let y = Math.floor((y0 - 2) * SS); y < Math.ceil((y0 + h + 2) * SS); y++) {
    for (let x = Math.floor((x0 - 2) * SS); x < Math.ceil((x0 + w + 2) * SS); x++) {
      const dx = Math.abs(x + 0.5 - cx) - (hw - rad)
      const dy = Math.abs(y + 0.5 - cy) - (hh - rad)
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
      const d = Math.min(Math.max(dx, dy), 0) + outside - rad
      const coverage = clamp(0.5 - d, 0, 1)
      if (coverage > 0) blend(x, y, r, g, b, coverage * alpha)
    }
  }
}

function softEllipse(cx, cy, rx, ry, r, g, b, alpha) {
  for (let y = Math.floor((cy - ry * 2.2) * SS); y < Math.ceil((cy + ry * 2.2) * SS); y++) {
    for (let x = Math.floor((cx - rx * 1.1) * SS); x < Math.ceil((cx + rx * 1.1) * SS); x++) {
      const dx = (x + 0.5) / SS - cx
      const dy = (y + 0.5) / SS - cy
      const n = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
      if (n >= 1) continue
      const falloff = Math.pow(1 - n, 1.6)
      blend(x, y, r, g, b, falloff * alpha)
    }
  }
}

// ---- the digest panel, as a wireframe hint ---------------------------------
// A single framed panel reads as "the digest panel"; three loose cards read as
// three random cards. Fake a soft drop shadow by stacking offset rounded rects
// with falling alpha, since there is no blur in this pipeline.
const panel = { x: 70, y: 96, w: 420, h: 520 }
for (let layer = 5; layer >= 1; layer--) {
  roundRect(
    panel.x - layer * 2,
    panel.y - layer * 2 + 10,
    panel.w + layer * 4,
    panel.h + layer * 4,
    20 + layer * 2,
    46,
    68,
    100,
    0.012 * layer,
  )
}
roundRect(panel.x, panel.y, panel.w, panel.h, 18, 255, 255, 255, 0.96)
roundRect(panel.x, panel.y, panel.w, panel.h, 18, 176, 198, 226, 1) // edge
roundRect(panel.x + 1.5, panel.y + 1.5, panel.w - 3, panel.h - 3, 16.5, 255, 255, 255, 1)

// title row: status dot + title line
softEllipse(panel.x + 30, panel.y + 34, 7, 7, 79, 209, 165, 1)
roundRect(panel.x + 46, panel.y + 28, 118, 12, 6, 108, 128, 156, 0.75)

const cards = [
  { y: panel.y + 62, chip: [246, 169, 74] }, // 竞赛
  { y: panel.y + 180, chip: [79, 209, 165] }, // 实习招聘
  { y: panel.y + 298, chip: [122, 168, 255] }, // AI 技术
]
for (const card of cards) {
  roundRect(panel.x + 20, card.y, panel.w - 40, 100, 14, 246, 249, 253, 1) // card bg
  roundRect(panel.x + 20, card.y, panel.w - 40, 100, 14, 205, 218, 236, 1) // card edge
  roundRect(panel.x + 21.5, card.y + 1.5, panel.w - 43, 97, 12.5, 252, 254, 255, 1)
  // topic chip
  roundRect(panel.x + 36, card.y + 16, 58, 19, 9.5, card.chip[0], card.chip[1], card.chip[2], 0.32)
  roundRect(panel.x + 36, card.y + 16, 58, 19, 9.5, card.chip[0], card.chip[1], card.chip[2], 0.9)
  roundRect(panel.x + 37.5, card.y + 17.5, 55, 16, 8, card.chip[0], card.chip[1], card.chip[2], 1)
  // title line (dark) and two body lines (light)
  roundRect(panel.x + 36, card.y + 46, 300, 11, 5.5, 52, 63, 84, 0.92)
  roundRect(panel.x + 36, card.y + 66, 250, 8, 4, 138, 152, 172, 0.75)
  roundRect(panel.x + 36, card.y + 80, 190, 8, 4, 168, 180, 197, 0.6)
}

// ---- the pet --------------------------------------------------------------
const sprite = PNG.sync.read(readFileSync(spritePath))
const targetHeight = 560
const scale = targetHeight / sprite.height
const tw = Math.round(sprite.width * scale)
const th = targetHeight
const baseX = Math.round(1150 - tw) // right-aligned with a margin
const baseY = Math.round(648 - th)

// Box-filter downscale with alpha weighting, so edges stay clean.
const small = new Float32Array(tw * th * 4)
for (let y = 0; y < th; y++) {
  const y0 = Math.floor((y * sprite.height) / th)
  const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sprite.height) / th))
  for (let x = 0; x < tw; x++) {
    const x0 = Math.floor((x * sprite.width) / tw)
    const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sprite.width) / tw))
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let n = 0
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (sy * sprite.width + sx) * 4
        const alpha = sprite.data[i + 3] / 255
        r += sprite.data[i] * alpha
        g += sprite.data[i + 1] * alpha
        b += sprite.data[i + 2] * alpha
        a += alpha
        n++
      }
    }
    const o = (y * tw + x) * 4
    const as = a || 1
    small[o] = r / as
    small[o + 1] = g / as
    small[o + 2] = b / as
    small[o + 3] = a / n
  }
}

// contact shadow, then the sprite
softEllipse(baseX + tw * 0.5, baseY + th - 6, tw * 0.36, 22, 40, 60, 90, 0.22)

// The canvas is supersampled, so each source pixel must fill an SS x SS block of
// subpixels. Filling only one subpixel per pixel made the sprite contribute a
// quarter of its colour after the final downsample — the whole pet came out at
// ~26% opacity.
for (let y = 0; y < th; y++) {
  for (let x = 0; x < tw; x++) {
    const i = (y * tw + x) * 4
    const alpha = small[i + 3]
    if (alpha <= 0.002) continue
    const r = small[i]
    const g = small[i + 1]
    const b = small[i + 2]
    const px = (baseX + x) * SS
    const py = (baseY + y) * SS
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) blend(px + sx, py + sy, r, g, b, alpha)
    }
  }
}

// ---- downsample the supersampled canvas -----------------------------------
const final = new PNG({ width: W, height: H })
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * CW + (x * SS + sx)) * 4
        r += out.data[i]
        g += out.data[i + 1]
        b += out.data[i + 2]
        a += out.data[i + 3]
      }
    }
    const o = (y * W + x) * 4
    const n = SS * SS
    final.data[o] = Math.round(r / n)
    final.data[o + 1] = Math.round(g / n)
    final.data[o + 2] = Math.round(b / n)
    final.data[o + 3] = Math.round(a / n)
  }
}

writeFileSync(outPath, PNG.sync.write(final, { colorType: 6 }))
console.log(`sprite  ${sprite.width}x${sprite.height} -> ${tw}x${th}`)
console.log(`wrote   ${outPath} (${W}x${H})`)
