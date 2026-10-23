// Diagnostic: run the exact matte flood fill and explain specific pixels.
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const BRIGHT = Number(process.env.MATTE_BRIGHT ?? 150)
const SAT = Number(process.env.MATTE_SAT ?? 30)
const png = PNG.sync.read(readFileSync(process.argv[2] ?? 'assets/pet-src.png'))
const { width: W, height: H, data } = png
const px = W * H
console.log(`pngjs channels check: data.length=${data.length} expected(4ch)=${px * 4} expected(3ch)=${px * 3}`)

const bg = new Uint8Array(px)
const stack = new Int32Array(px)
let sp = 0
const vals = (p) => {
  const i = p * 4
  const r = data[i], g = data[i + 1], b = data[i + 2]
  return { r, g, b, mn: Math.min(r, g, b), spread: Math.max(r, g, b) - Math.min(r, g, b) }
}
const bgLike = (p) => {
  const v = vals(p)
  return v.mn >= BRIGHT && v.spread <= SAT
}
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const p = y * W + x
  if (bg[p] || !bgLike(p)) return
  bg[p] = 1
  stack[sp++] = p
}
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1) }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y) }
while (sp > 0) {
  const p = stack[--sp]
  const x = p % W
  const y = (p - x) / W
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
}
console.log(`thresholds: mn>=${BRIGHT} spread<=${SAT}`)
console.log(`marked background: ${bg.reduce((n, v) => n + v, 0)} / ${px}`)

for (const [x, y] of [[300, 1150], [400, 1150], [400, 1170], [460, 1100], [350, 1120], [200, 1180], [300, 1185]]) {
  const p = y * W + x
  const v = vals(p)
  console.log(`  (${x},${y}) rgb(${v.r},${v.g},${v.b}) mn=${v.mn} spread=${v.spread} bgLike=${bgLike(p)} marked=${bg[p] === 1}`)
}

// Bottom band: what is left as foreground, and why?
let fg = 0
const reasons = new Map()
for (let y = H - 120; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x
    if (bg[p]) continue
    fg++
    const v = vals(p)
    const why = v.mn < BRIGHT ? `dark(mn=${v.mn < 100 ? '<100' : v.mn})` : `saturated(spread=${v.spread})`
    reasons.set(why, (reasons.get(why) ?? 0) + 1)
  }
}
console.log(`\nbottom band foreground: ${fg} px`)
console.log('reasons:', [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join('  '))
