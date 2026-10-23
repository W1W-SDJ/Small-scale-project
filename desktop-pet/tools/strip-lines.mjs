// Strip thin horizontal decorations that background removal cannot reach.
//
//   node tools/strip-lines.mjs <in.png> <out.png> [--min-v=170] [--max-s=60]
//                              [--max-run=12] [--band=0.45] [--blue-bias=3]
//
// The whale-girl art sits on a pale blue gradient with decorative wave lines.
// Those lines survive a flood fill for two reasons: their saturation defeats the
// strict "bright and desaturated" test, and they touch the character, so they are
// part of the same connected component as the body — connected-component
// cleanup cannot separate them.
//
// What separates them anyway is *thickness*. A decorative squiggle is a few
// pixels tall at any given column; the creature's own pale areas (rice, cape,
// cloth) are thick blobs. So: classify pale, slightly-blue pixels, measure each
// column's vertical run length, and drop the runs that are too short to be part
// of the subject. Warm pixels are never touched, which keeps skin and the rice
// safe even where they are just as bright.
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
  console.error('usage: node tools/strip-lines.mjs <in.png> <out.png> [--min-v=170] [--max-s=60] [--max-run=12] [--band=0.45]')
  process.exit(1)
}

const MIN_V = option('min-v', 170)
const MAX_S = option('max-s', 60)
const MAX_RUN = option('max-run', 12)
const BAND = option('band', 0.45)
const BLUE_BIAS = option('blue-bias', 3)
const EDGE_RADIUS = option('edge-radius', 3)
const PAD = option('pad', 4)

const png = PNG.sync.read(readFileSync(src))
const { width: W, height: H, data } = png
const bandTop = Math.floor(H * (1 - BAND))

/** Pale, low-saturation, slightly cool: the palette of the decoration lines. */
const classify = new Uint8Array(W * H)
for (let y = bandTop; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x
    const i = p * 4
    if (data[i + 3] < 16) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const min = Math.min(r, g, b)
    const max = Math.max(r, g, b)
    if (min < MIN_V || max - min > MAX_S) continue
    if (b < r + BLUE_BIAS) continue
    classify[p] = 1
  }
}

// Only pixels that sit next to removed background may be stripped. A decoration
// line lies along the silhouette edge (transparent on at least one side),
// whereas a pale pattern printed *on* the character — the wave band on the rice
// wrap, for instance — is surrounded by opaque artwork and must survive. Without
// this test the same colour+thickness rule eats that artwork too.
const nearEdge = new Uint8Array(W * H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] < 16) nearEdge[y * W + x] = 1
  }
}
for (let step = 0; step < EDGE_RADIUS; step++) {
  const previous = nearEdge.slice()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (previous[p]) continue
      const up = y > 0 && previous[p - W]
      const down = y < H - 1 && previous[p + W]
      const left = x > 0 && previous[p - 1]
      const right = x < W - 1 && previous[p + 1]
      if (up || down || left || right) nearEdge[p] = 1
    }
  }
}

let removed = 0
for (let x = 0; x < W; x++) {
  let y = bandTop
  while (y < H) {
    const p = y * W + x
    if (!classify[p] || !nearEdge[p]) {
      y++
      continue
    }
    let end = y
    while (end < H && classify[end * W + x] && nearEdge[end * W + x]) end++
    const run = end - y
    if (run <= MAX_RUN) {
      for (let yy = y; yy < end; yy++) {
        const i = (yy * W + x) * 4
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
        data[i + 3] = 0
        removed++
      }
    }
    y = end
  }
}

// Trim to what is left. A few near-invisible pixels of a removed line still
// stretch the bounding box across the whole canvas, which would make the pet
// small and off-centre on screen — so a column/row only counts if it holds a
// meaningful number of opaque pixels, not just one spec.
const columnCount = new Uint32Array(W)
const rowCount = new Uint32Array(H)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] <= 4) continue
    columnCount[x]++
    rowCount[y]++
  }
}

const MIN_COLUMN = option('min-column', Math.max(8, Math.round(H * 0.004)))
const MIN_ROW = option('min-row', Math.max(8, Math.round(W * 0.004)))

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

console.log(`band         y>=${bandTop} (${Math.round(BAND * 100)}% of ${H})`)
console.log(`removed      ${removed} px (runs <= ${MAX_RUN} tall, min ${MIN_V}, spread <= ${MAX_S}, b-r >= ${BLUE_BIAS}, within ${EDGE_RADIUS}px of transparent)`)
console.log(`trimmed     ${x0},${y0} ${cw}x${ch} (aspect ${(cw / ch).toFixed(4)})`)
console.log(`wrote       ${out}`)
