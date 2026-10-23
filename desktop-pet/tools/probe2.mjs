// Diagnostic: what does the *produced* sprite's alpha channel actually look like?
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const png = PNG.sync.read(readFileSync(process.argv[2] ?? 'assets/pet.png'))
const { width: W, height: H, data } = png
const A = (x, y) => data[(y * W + x) * 4 + 3]

console.log(`pet.png ${W}x${H}`)
let partial = 0, opaque = 0, clear = 0
for (let p = 0; p < W * H; p++) {
  const a = data[p * 4 + 3]
  if (a === 0) clear++
  else if (a === 255) opaque++
  else partial++
}
console.log(`alpha: clear=${clear} partial=${partial} opaque=${opaque}`)

// Coarse alpha map of the bottom third, 12px cells.
const step = 12
console.log('\nalpha map (bottom third; " "=0  "."<64  "+"<192  "#">=192):')
for (let y = Math.floor((H * 2) / 3); y < H; y += step) {
  let line = ''
  for (let x = 0; x < W; x += step) {
    let a = 0
    for (let dy = 0; dy < step && y + dy < H; dy++) {
      for (let dx = 0; dx < step && x + dx < W; dx++) a = Math.max(a, A(x + dx, y + dy))
    }
    line += a === 0 ? ' ' : a < 64 ? '.' : a < 192 ? '+' : '#'
  }
  console.log(`y=${String(y).padStart(4)} |${line}|`)
}

// Where are the partial-alpha pixels concentrated?
let minX = W, minY = H, maxX = -1, maxY = -1
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = A(x, y)
    if (a > 0 && a < 250) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
}
console.log(`\npartial/faint alpha bbox: ${minX},${minY} .. ${maxX},${maxY}`)
