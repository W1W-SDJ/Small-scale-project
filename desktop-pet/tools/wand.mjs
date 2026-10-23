// Background removal for illustrations on a *scene* background.
//
//   node tools/wand.mjs <in.png> <out.png> [--tol=12] [--warm-guard=8] [--min-v=110]
//
// tools/matte.mjs assumes a white studio background: it removes "bright and
// desaturated". That fails on coloured scenes (pale blue sky, clouds, hearts) —
// the fill stops at anything with a bit of hue and leaves the scene behind.
//
// This tool instead grows a region from the image border and accepts a neighbour
// when it is close to the pixel it is reached from (small per-step colour
// distance, so gradients are followed rather than jumped). Two guards keep the
// fill out of the character:
//   * --min-v:        never eat very dark pixels (hair, outlines);
//   * --warm-guard:   never eat pixels notably warmer than the background, which
//                     is what skin, the rice and the wood/cream tones are, while
//                     a cool sky/cloud background has b >= r.
// The result is then trimmed; decorations enclosed by the subject survive, which
// is intended — run tools/despeckle.mjs afterwards to drop detached specks.
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
  console.error('usage: node tools/wand.mjs <in.png> <out.png> [--tol=12] [--warm-guard=8] [--min-v=110]')
  process.exit(1)
}

const TOL = option('tol', 12)
const WARM_GUARD = option('warm-guard', 8)
const MIN_V = option('min-v', 110)
const PAD = option('pad', 4)

const png = PNG.sync.read(readFileSync(src))
const { width: W, height: H, data } = png
const count = W * H

const removed = new Uint8Array(count)
const stack = new Int32Array(count)
let sp = 0

const channelValue = (p) => {
  const i = p * 4
  const r = data[i]
  const g = data[i + 1]
  const b = data[i + 2]
  return r > g ? (r > b ? r : b) : g > b ? g : b
}

const acceptable = (from, to) => {
  if (removed[to]) return false
  const a = channelValue(to)
  if (a < MIN_V) return false
  const ia = to * 4
  if (data[ia] - data[ia + 2] > WARM_GUARD) return false // warm pixels are subject
  const ib = from * 4
  const d = Math.max(
    Math.abs(data[ia] - data[ib]),
    Math.abs(data[ia + 1] - data[ib + 1]),
    Math.abs(data[ia + 2] - data[ib + 2]),
  )
  return d <= TOL
}

const push = (from, to) => {
  if (to < 0 || to >= count || removed[to]) return
  if (!acceptable(from, to)) return
  removed[to] = 1
  stack[sp++] = to
}

// Seed every border pixel as background, then grow.
for (let x = 0; x < W; x++) {
  for (const p of [x, (H - 1) * W + x]) {
    if (removed[p]) continue
    if (channelValue(p) < MIN_V) continue
    removed[p] = 1
    stack[sp++] = p
  }
}
for (let y = 0; y < H; y++) {
  for (const p of [y * W, y * W + W - 1]) {
    if (removed[p]) continue
    if (channelValue(p) < MIN_V) continue
    removed[p] = 1
    stack[sp++] = p
  }
}

while (sp > 0) {
  const p = stack[--sp]
  const x = p % W
  const y = (p - x) / W
  if (x > 0) push(p, p - 1)
  if (x < W - 1) push(p, p + 1)
  if (y > 0) push(p, p - W)
  if (y < H - 1) push(p, p + W)
}

let cleared = 0
for (let p = 0; p < count; p++) {
  if (!removed[p]) continue
  const i = p * 4
  data[i] = 0
  data[i + 1] = 0
  data[i + 2] = 0
  data[i + 3] = 0
  cleared++
}

// Trim to the remaining content, ignoring lone specks (they would otherwise keep
// the bounding box at the full canvas size).
const columnCount = new Uint32Array(W)
const rowCount = new Uint32Array(H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] <= 4) continue
    columnCount[x]++
    rowCount[y]++
  }
}
const MIN_COLUMN = Math.max(8, Math.round(H * 0.004))
const MIN_ROW = Math.max(8, Math.round(W * 0.004))

let minX = W
let minY = H
let maxX = -1
let maxY = -1
for (let x = 0; x < W; x++) {
  if (columnCount[x] < MIN_COLUMN) continue
  if (x < minX) minX = x
  if (x > maxX) maxX = x
}
for (let y = 0; y < H; y++) {
  if (rowCount[y] < MIN_ROW) continue
  if (y < minY) minY = y
  if (y > maxY) maxY = y
}
if (maxX < 0 || maxY < 0) {
  minX = 0
  minY = 0
  maxX = W - 1
  maxY = H - 1
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

console.log(`cleared      ${cleared} px (tol ${TOL}, warm-guard ${WARM_GUARD}, min-v ${MIN_V})`)
console.log(`trimmed     ${x0},${y0} ${cw}x${ch} (aspect ${(cw / ch).toFixed(4)})`)
console.log(`wrote       ${out}`)
