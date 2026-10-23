// Box-filter downscale for sprites.
//
//   node tools/resize.mjs <in.png> <out.png> [--height=900] [--width=0]
//
// Source art is often 1500-2000 px tall while the pet is drawn at ~340 DIP (and
// up to ~510 physical px at 150 % scaling). Shipping the full-size bitmap means
// every skin change pushes megabytes through IPC for pixels nobody sees, so the
// sprite is downscaled once, at build time. A box filter is deliberate here:
// averaging is exactly right for downscaling line art, and it needs no
// dependency beyond the PNG decoder we already use.
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
  console.error('usage: node tools/resize.mjs <in.png> <out.png> [--height=900] [--width=0]')
  process.exit(1)
}

const targetHeight = option('height', 900)
const targetWidthArg = option('width', 0)

const png = PNG.sync.read(readFileSync(src))
const { width: W, height: H } = png
const scale = targetWidthArg ? targetWidthArg / W : targetHeight / H
const outW = Math.max(1, Math.round(W * scale))
const outH = Math.max(1, Math.round(H * scale))

const dst = new PNG({ width: outW, height: outH })

// Precompute source ranges per output column/row so the inner loop stays tight.
const xRanges = []
for (let x = 0; x < outW; x++) {
  const start = Math.floor((x * W) / outW)
  const end = Math.max(start + 1, Math.floor(((x + 1) * W) / outW))
  xRanges.push([start, Math.min(end, W)])
}
const yRanges = []
for (let y = 0; y < outH; y++) {
  const start = Math.floor((y * H) / outH)
  const end = Math.max(start + 1, Math.floor(((y + 1) * H) / outH))
  yRanges.push([start, Math.min(end, H)])
}

for (let y = 0; y < outH; y++) {
  const [y0, y1] = yRanges[y]
  for (let x = 0; x < outW; x++) {
    const [x0, x1] = xRanges[x]
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let n = 0
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (sy * W + sx) * 4
        const alpha = png.data[i + 3] / 255
        // Weight colour by alpha so transparent pixels do not darken the edges.
        r += png.data[i] * alpha
        g += png.data[i + 1] * alpha
        b += png.data[i + 2] * alpha
        a += alpha
        n++
      }
    }
    const o = (y * outW + x) * 4
    const alphaSum = a || 1
    dst.data[o] = Math.round(r / alphaSum)
    dst.data[o + 1] = Math.round(g / alphaSum)
    dst.data[o + 2] = Math.round(b / alphaSum)
    dst.data[o + 3] = Math.round((a / n) * 255)
  }
}

writeFileSync(out, PNG.sync.write(dst, { colorType: 6 }))
console.log(`${src} ${W}x${H} -> ${out} ${outW}x${outH} (scale ${scale.toFixed(3)})`)
