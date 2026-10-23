// Preview helper: composite an RGBA sprite over a solid colour or a
// checkerboard, optionally cropping and upscaling so edges can be judged.
//
//   node tools/preview.mjs pet.png out.png [--bg=dark|light|checker|magenta]
//                                             [--crop=x,y,w,h] [--scale=3]
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const args = process.argv.slice(2)
const src = args[0]
const out = args[1]
const opt = Object.fromEntries(
  args.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]
  }),
)
const png = PNG.sync.read(readFileSync(src))
let { width: W, height: H } = png
let data = png.data

if (opt.crop) {
  const [cx, cy, cw, ch] = String(opt.crop).split(',').map(Number)
  const c = new PNG({ width: cw, height: ch })
  PNG.bitblt(png, c, cx, cy, cw, ch, 0, 0)
  data = c.data
  W = cw
  H = ch
}
const scale = Number(opt.scale ?? 1)

const bgKind = opt.bg ?? 'dark'
const sample = (x, y) => {
  if (bgKind === 'dark') return [32, 32, 36]
  if (bgKind === 'light') return [245, 245, 245]
  if (bgKind === 'magenta') return [255, 0, 255]
  const cell = 12
  return (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? [150, 150, 155] : [205, 205, 210]
}

const OW = W * scale
const OH = H * scale
const outPng = new PNG({ width: OW, height: OH })
for (let y = 0; y < OH; y++) {
  for (let x = 0; x < OW; x++) {
    const sx = Math.floor(x / scale)
    const sy = Math.floor(y / scale)
    const i = (sy * W + sx) * 4
    const a = data[i + 3] / 255
    const [br, bg, bb] = sample(sx, sy)
    const o = (y * OW + x) * 4
    outPng.data[o] = Math.round(data[i] * a + br * (1 - a))
    outPng.data[o + 1] = Math.round(data[i + 1] * a + bg * (1 - a))
    outPng.data[o + 2] = Math.round(data[i + 2] * a + bb * (1 - a))
    outPng.data[o + 3] = 255
  }
}
writeFileSync(out, PNG.sync.write(outPng, { colorType: 6 }))
console.log(`wrote ${out}  ${OW}x${OH}  bg=${bgKind}${opt.crop ? ` crop=${opt.crop}` : ''}${scale !== 1 ? ` scale=${scale}` : ''}`)
