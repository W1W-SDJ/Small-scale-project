// Recolour a sprite while keeping all of its shading.
//
//   node tools/recolor.mjs <src.png> <out.png> <hue> [satScale] [lightScale]
//
// Hue is replaced in HSL space (not blended or multiplied), so the highlights
// and shadows of the original artwork survive — a tinted blob still looks like
// the same painted creature, just in another colour. Multiplied tints go muddy
// on the yellow original because yellow carries very little blue to scale.
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const [src, out, hueArg, satArg, lightArg] = process.argv.slice(2)
if (!src || !out || hueArg === undefined) {
  console.error('usage: node tools/recolor.mjs <src.png> <out.png> <hue 0-360> [satScale] [lightScale]')
  process.exit(1)
}

const targetHue = ((Number(hueArg) % 360) + 360) % 360
const satScale = satArg === undefined ? 1 : Number(satArg)
const lightScale = lightArg === undefined ? 1 : Number(lightArg)

const png = PNG.sync.read(readFileSync(src))
const count = png.width * png.height

function rgbToHsl(r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

function hueToRgb(p, q, t) {
  let x = t
  if (x < 0) x += 1
  if (x > 1) x -= 1
  if (x < 1 / 6) return p + (q - p) * 6 * x
  if (x < 1 / 2) return q
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
  return p
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  ]
}

let touched = 0
for (let p = 0; p < count; p++) {
  const i = p * 4
  if (png.data[i + 3] === 0) continue
  const [h, s, l] = rgbToHsl(png.data[i], png.data[i + 1], png.data[i + 2])
  // Near-grey pixels (eyes, outlines) keep their hue: rotating them would make
  // the creature look dead-eyed.
  if (s < 0.06) continue
  const hh = targetHue / 360
  const ss = Math.min(1, Math.max(0, s * satScale))
  const ll = Math.min(0.98, Math.max(0.02, l * lightScale))
  const [r, g, b] = hslToRgb(hh, ss, ll)
  png.data[i] = r
  png.data[i + 1] = g
  png.data[i + 2] = b
  touched++
}

writeFileSync(out, PNG.sync.write(png, { colorType: 6 }))
console.log(`${src} -> ${out}  hue=${targetHue} sat×${satScale} light×${lightScale}  (${touched} px recoloured)`)
