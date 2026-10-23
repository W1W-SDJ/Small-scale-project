// Diagnostic: what exactly are the pixels the flood fill left behind?
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const png = PNG.sync.read(readFileSync(process.argv[2] ?? 'assets/pet-src.png'))
const { width: W, height: H, data } = png

const stat = (p) => {
  const i = p * 4
  const r = data[i], g = data[i + 1], b = data[i + 2]
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  return { r, g, b, mn, spread: mx - mn }
}

// Histogram of brightness among "neutral" pixels (spread <= 30), by row band.
console.log('neutral pixels (spread<=30) by brightness bucket, per vertical band:')
const bands = 12
const buckets = [100, 120, 140, 160, 180, 200, 220, 236, 246, 256]
for (let bidx = 0; bidx < bands; bidx++) {
  const y0 = Math.floor((bidx * H) / bands)
  const y1 = Math.floor(((bidx + 1) * H) / bands)
  const counts = new Array(buckets.length).fill(0)
  let neutral = 0
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const s = stat(y * W + x)
      if (s.spread > 30) continue
      neutral++
      for (let k = 0; k < buckets.length; k++) {
        if (s.mn < buckets[k]) { counts[k]++; break }
      }
    }
  }
  const line = counts.map((c, k) => `${k === 0 ? '<' : ''}${buckets[k]}:${c}`).join(' ')
  console.log(`  y ${String(y0).padStart(4)}-${String(y1).padStart(4)}  neutral=${String(neutral).padStart(6)}  ${line}`)
}

// Column scan straight through the contact shadow under the left foot.
const xs = [220, 260, 300]
for (const x of xs) {
  console.log(`\ncolumn x=${x}, y from 990 to ${H - 1}:`)
  let line = ''
  for (let y = 990; y < H; y++) {
    const s = stat(y * W + x)
    if (y % 6 === 0) line += `\n  y=${String(y).padStart(4)} rgb(${s.r},${s.g},${s.b}) mn=${String(s.mn).padStart(3)} spread=${String(s.spread).padStart(3)}`
  }
  console.log(line)
}

// Where do the desaturated-but-not-bright pixels live? (candidate shadow core)
let minX = W, minY = H, maxX = -1, maxY = -1, n = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = stat(y * W + x)
    if (s.spread <= 30 && s.mn >= 100 && s.mn < 180) {
      n++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
}
console.log(`\nneutral & mid-dark (mn 100..180): ${n} px, bbox ${minX},${minY} .. ${maxX},${maxY}`)
