'use strict'

// Headless check of the renderer-side sprite preparation (skinprep.js).
//
//   node_modules\electron\dist\electron.exe tools/test-skinprep.cjs <src.png> <out.png>
//
// The panel prepares dropped pictures with exactly this code, and it only runs in
// a browser context (canvas decoding is the whole point). Driving it from a
// hidden BrowserWindow is therefore the only honest way to test it — and it needs
// no GUI on screen because the window is never shown.

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const [src, out] = process.argv.slice(2).filter((arg) => arg && !arg.startsWith('--'))
if (!src || !out) {
  console.error('usage: electron tools/test-skinprep.cjs <src.png> <out.png>')
  process.exit(2)
}

if (process.env.PET_USER_DATA) app.setPath('userData', process.env.PET_USER_DATA)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 300,
    height: 200,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  })
  try {
    await win.loadFile(path.join(__dirname, 'skinprep-harness.html'))
    const dataUrl = `data:image/png;base64,${fs.readFileSync(src).toString('base64')}`
    const result = await win.webContents.executeJavaScript(
      `window.prepare(${JSON.stringify(dataUrl)})`,
      true,
    )
    const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(base64, 'base64'))

    console.log(`source       ${path.basename(src)}`)
    console.log(`method       ${result.method}  (transparent before: ${(result.coverageBefore * 100).toFixed(1)}%, decorations dropped: ${result.dropped} px)`)
    console.log(`result       ${result.width}x${result.height}  transparent ${(result.coverageAfter * 100).toFixed(1)}%  solid ${(result.solidRatio * 100).toFixed(1)}%`)
    console.log(`wrote        ${out}`)
    app.exit(0)
  } catch (error) {
    console.error('FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})
