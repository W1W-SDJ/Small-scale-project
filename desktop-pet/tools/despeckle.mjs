// Remove disconnected specks and stray lines left behind by background removal.
//
//   node tools/despeckle.mjs <in.png> <out.png> [--pad=4] [--min-area=400] [--min-ratio=0.004]
//
// Background art often carries decorations that are brighter/less saturated than
// the subject, so the flood fill cannot reach them: sparkles, wave lines, frames,
// UI chrome from wherever the picture came from. They are disconnected from the
// character, which makes them trivial to drop by connected-component area — the
// catch is telling a decoration from a legitimate detached part of the subject
// (a floating accessory), so a component also survives if it is close to the
// main body, and thin full-width/full-height lines are always dropped.
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}

const [src, out] = positional
if (!src || !out) {
  console.error('usage: node tools/despeckle.mjs <in.png> <out.png> [--pad=4] [--min-area=400] [--min-ratio=0.004]')
  process.exit(1)
}

const PAD = option('pad', 4)
const MIN_AREA = option('min-area', 400)
const MIN_RATIO = option('min-ratio', 0.004)
const ALPHA = 16
const NEAR_PX = 10

const png = PNG.sync.read(readFileSync(src))
const { width: W, height: H, data } = png
const count = W * H

// ---- label components -----------------------------------------------------
const labels = new Int32Array(count).fill(-1)
const stack = new Int32Array(count)
const components = []

for (let start = 0; start < count; start++) {
  if (labels[start] !== -1 || data[start * 4 + 3] < ALPHA) continue
  const id = components.length
  let sp = 0
  stack[sp++] = start
  labels[start] = id
  let area = 0
  let minX = W
  let minY = H
  let maxX = -1
  let maxY = -1

  while (sp > 0) {
    const p = stack[--sp]
    area++
    const x = p % W
    const y = (p - x) / W
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    const tryPush = (q) => {
      if (labels[q] !== -1) return
      if (data[q * 4 + 3] < ALPHA) return
      labels[q] = id
      stack[sp++] = q
    }
    if (x > 0) tryPush(p - 1)
    if (x < W - 1) tryPush(p + 1)
    if (y > 0) tryPush(p - W)
    if (y < H - 1) tryPush(p + W)
  }

  components.push({ id, area, minX, minY, maxX, maxY })
}

if (!components.length) {
  console.log('nothing opaque — leaving the file alone')
  writeFileSync(out, PNG.sync.write(png, { colorType: 6 }))
  process.exit(0)
}

// ---- decide what survives ------------------------------------------------
const main = components.reduce((best, c) => (c.area > best.area ? c : best), components[0])
const near = (c, other) =>
  c.minX <= other.maxX + NEAR_PX &&
  c.maxX >= other.minX - NEAR_PX &&
  c.minY <= other.maxY + NEAR_PX &&
  c.maxY >= other.minY - NEAR_PX

const minArea = Math.max(MIN_AREA, main.area * MIN_RATIO)
const keep = new Set([main.id])
const dropped = []

for (const c of components) {
  if (c.id === main.id) continue
  const w = c.maxX - c.minX + 1
  const h = c.maxY - c.minY + 1
  // Decoration detector. A background sparkle or wave line is either tiny, or
  // long and hair-thin across the frame; a detached piece of the subject is
  // usually chunky. Both are compared with the main body, not with the canvas,
  // so this works on tight crops as well as full-page art.
  const thinLine = (w > W * 0.55 && h < H * 0.06) || (h > H * 0.55 && w < W * 0.06)
  const small = c.area < minArea
  if (thinLine || small) {
    dropped.push({ area: c.area, box: `${w}x${h}`, why: thinLine ? 'thin line' : 'small' })
    continue
  }
  keep.add(c.id)
}

for (let p = 0; p < count; p++) {
  const id = labels[p]
  if (id === -1 || keep.has(id)) continue
  const i = p * 4
  data[i] = 0
  data[i + 1] = 0
  data[i + 2] = 0
  data[i + 3] = 0
}

// ---- trim to what is left ------------------------------------------------
let minX = W
let minY = H
let maxX = -1
let maxY = -1
for (let p = 0; p < count; p++) {
  if (data[p * 4 + 3] <= 4) continue
  const x = p % W
  const y = (p - x) / W
  if (x < minX) minX = x
  if (y < minY) minY = y
  if (x > maxX) maxX = x
  if (y > maxY) maxY = y
}

const x0 = Math.max(0, minX - PAD)
const y0 = Math.max(0, minY - PAD)
const x1 = Math.min(W - 1, maxX + PAD)
const y1 = Math.min(H - 1, maxY + PAD)
const cw = x1 - x0 + 1
const ch = y1 - y0 + 1

const trimmed = new PNG({ width: cw, height: ch })
PNG.bitblt(png, trimmed, x0, y0, cw, ch, 0, 0)
writeFileSync(out, PNG.sync.write(trimmed, { colorType: 6 }))

// Magenta-composited preview so transparency is obvious at a glance.
const preview = new PNG({ width: cw, height: ch })
for (let p = 0; p < cw * ch; p++) {
  const i = p * 4
  const a = trimmed.data[i + 3] / 255
  preview.data[i] = Math.round(trimmed.data[i] * a + 255 * (1 - a))
  preview.data[i + 1] = Math.round(trimmed.data[i + 1] * a)
  preview.data[i + 2] = Math.round(trimmed.data[i + 2] * a + 255 * (1 - a))
  preview.data[i + 3] = 255
}
writeFileSync(out.replace(/\.png$/, '-preview.png'), PNG.sync.write(preview, { colorType: 6 }))

console.log(`components   ${components.length} (main ${main.area} px)`)
if (args.includes('--verbose')) {
  for (const c of components) console.log(`  #${c.id} ${String(c.area).padStart(8)} px ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1}`)
}
for (const d of dropped.slice(0, 12)) console.log(`  dropped ${String(d.area).padStart(7)} px ${d.box.padEnd(10)} ${d.why}`)
if (dropped.length > 12) console.log(`  ... ${dropped.length - 12} more dropped`)
console.log(`kept         ${keep.size} components`)
console.log(`trimmed     ${x0},${y0} ${cw}x${ch} (aspect ${(cw / ch).toFixed(4)})`)
console.log(`wrote       ${out}`)
