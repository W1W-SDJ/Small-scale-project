// One-shot sprite preparation: turn the white-background render into a
// transparent PNG with a clean anti-aliased edge.
//
//   node tools/matte.mjs [src] [out]
//
// A pixel counts as background when it is bright AND desaturated, and only
// pixels reachable from the image border are removed (flood fill). That keeps
// bright, low-saturation areas *inside* the creature (belly highlight, eye
// whites) intact, because they are not connected to the border.
//
// The render also bakes a soft contact shadow under the feet. Its interior is
// pale, but it is walled in by a warm-grey ring whose channel spread (~34)
// exceeds the strict saturation bound, so the strict fill stops at the ring and
// leaves an opaque white blob. A second fill therefore runs with a looser
// bound, seeded only from already-confirmed background in the bottom band and
// confined to it. That vertical guard is what keeps the pale belly — which is
// also mildly desaturated — out of reach.
//
// The binary mask is then blurred by one pixel to rebuild an anti-aliased edge,
// and edge colour is un-premultiplied against white so no pale fringe survives.
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const src = process.argv[2] ?? 'assets/pet-src.png'
const out = process.argv[3] ?? 'assets/pet.png'
const preview = out.replace(/\.png$/, '-preview.png')

const BRIGHT = Number(process.env.MATTE_BRIGHT ?? 200)       // strict: min channel
const SAT = Number(process.env.MATTE_SAT ?? 26)              // strict: channel spread
const SHADOW_BRIGHT = Number(process.env.MATTE_SHADOW_BRIGHT ?? 150)
const SHADOW_SAT = Number(process.env.MATTE_SHADOW_SAT ?? 60)
const SHADOW_SEED_Y = Number(process.env.MATTE_SHADOW_SEED_Y ?? 0.8)   // seeds below this fraction of H
const SHADOW_LIMIT_Y = Number(process.env.MATTE_SHADOW_LIMIT_Y ?? 0.6) // expand no higher than this
const PAD = Number(process.env.MATTE_PAD ?? 4)

const png = PNG.sync.read(readFileSync(src))
const { width: W, height: H, data } = png
const px = W * H

const V = new Uint8Array(px)      // min channel
const S = new Uint8Array(px)      // channel spread
for (let p = 0; p < px; p++) {
  const i = p * 4
  const r = data[i], g = data[i + 1], b = data[i + 2]
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b)
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
  V[p] = mn
  S[p] = mx - mn
}

const bg = new Uint8Array(px)     // 0 = foreground, 1 = strict background, 2 = shadow pass
const stack = new Int32Array(px)
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

// Pass A: the true outside.
const strict = (p) => V[p] >= BRIGHT && S[p] <= SAT
for (let x = 0; x < W; x++) { pushIf(x, strict, 1); pushIf((H - 1) * W + x, strict, 1) }
for (let y = 0; y < H; y++) { pushIf(y * W, strict, 1); pushIf(y * W + W - 1, strict, 1) }
expand(strict, 0, 1)
const strictCount = bg.reduce((n, v) => n + (v === 1 ? 1 : 0), 0)

// Pass B: the baked contact shadow, reachable only from the bottom band.
const seedY = Math.floor(H * SHADOW_SEED_Y)
const limitY = Math.floor(H * SHADOW_LIMIT_Y)
sp = 0
for (let y = seedY; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x
    if (bg[p] === 1) stack[sp++] = p
  }
}
const loose = (p) => V[p] >= SHADOW_BRIGHT && S[p] <= SHADOW_SAT
expand(loose, limitY, 2)
const shadowCount = bg.reduce((n, v) => n + (v === 2 ? 1 : 0), 0)

// Binary alpha, then one box-blur pass (separable, radius 1) for the soft edge.
const a0 = new Float32Array(px)
for (let p = 0; p < px; p++) a0[p] = bg[p] ? 0 : 1
const tmp = new Float32Array(px)
const a = new Float32Array(px)
const blurH = (input, output) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= W) continue
        sum += input[y * W + nx]; n++
      }
      output[y * W + x] = sum / n
    }
  }
}
const blurV = (input, output) => {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= H) continue
        sum += input[ny * W + x]; n++
      }
      output[y * W + x] = sum / n
    }
  }
}
blurH(a0, tmp)
blurV(tmp, a)

// Drop specks: faint edge pixels with no opaque pixel anywhere around them are
// leftovers of the shadow gradient, not silhouette.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x
    if (a[p] === 0 || a[p] >= 0.5) continue
    let strong = 0
    for (let dy = -1; dy <= 1 && strong === 0; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (a0[ny * W + nx] === 1) { strong = 1; break }
      }
    }
    if (strong === 0) a[p] = 0
  }
}

const out2 = new PNG({ width: W, height: H })
let minX = W, minY = H, maxX = -1, maxY = -1
const CV = 0.02
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x
    const i = p * 4
    let alpha = a[p]
    if (alpha < CV) alpha = 0
    let r = data[i], g = data[i + 1], b = data[i + 2]
    if (alpha > 0 && alpha < 1) {
      r = (r - 255 * (1 - alpha)) / alpha
      g = (g - 255 * (1 - alpha)) / alpha
      b = (b - 255 * (1 - alpha)) / alpha
    }
    const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
    out2.data[i] = cl(r)
    out2.data[i + 1] = cl(g)
    out2.data[i + 2] = cl(b)
    out2.data[i + 3] = Math.round(alpha * 255)
    if (alpha > 0) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
}

const x0 = Math.max(0, minX - PAD)
const y0 = Math.max(0, minY - PAD)
const x1 = Math.min(W - 1, maxX + PAD)
const y1 = Math.min(H - 1, maxY + PAD)
const cw = x1 - x0 + 1
const ch = y1 - y0 + 1
const trimmed = new PNG({ width: cw, height: ch })
PNG.bitblt(out2, trimmed, x0, y0, cw, ch, 0, 0)

writeFileSync(out, PNG.sync.write(trimmed, { colorType: 6 }))

const prev = new PNG({ width: cw, height: ch })
for (let p = 0; p < cw * ch; p++) {
  const i = p * 4
  const al = trimmed.data[i + 3] / 255
  prev.data[i] = Math.round(trimmed.data[i] * al + 255 * (1 - al))
  prev.data[i + 1] = Math.round(trimmed.data[i + 1] * al)
  prev.data[i + 2] = Math.round(trimmed.data[i + 2] * al + 255 * (1 - al))
  prev.data[i + 3] = 255
}
writeFileSync(preview, PNG.sync.write(prev, { colorType: 6 }))

console.log(`source      ${W}x${H}`)
console.log(`strict bg   ${strictCount} px  (min>=${BRIGHT}, spread<=${SAT})`)
console.log(`shadow bg   ${shadowCount} px  (min>=${SHADOW_BRIGHT}, spread<=${SHADOW_SAT}, y>=${limitY} seeded y>=${seedY})`)
console.log(`trimmed     ${x0},${y0} ${cw}x${ch} (aspect ${(cw / ch).toFixed(4)})`)
console.log(`wrote       ${out}`)
console.log(`wrote       ${preview}`)
