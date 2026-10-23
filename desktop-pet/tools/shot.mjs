// Capture the screen from inside Electron (no external screenshot tool needed).
//
//   electron tools/shot.mjs out.png
//
// Also prints every display's bounds and scale factor, which is what the
// physical-pixel mouse test needs in order to aim at the window.
//
// NOTE: this file is an ES module (the .mjs extension forces it, regardless of
// package.json), so it must use `import` — `require` is not defined in ES
// module scope. Written with a default import rather than named ones so the
// CommonJS `electron` module interops the same way in every Electron version.
//
// Every failure path is caught and reported on stderr: Electron's default
// handler for an uncaught main-process exception raises a modal
// "A JavaScript error occurred in the main process" dialog, which is a hostile
// thing to do to somebody's desktop.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import electron from 'electron'

const { app, desktopCapturer, screen } = electron

function fail(error) {
  const text = error?.stack ?? String(error)
  console.error(`shot.mjs failed: ${text}`)
  try {
    writeFileSync(path.resolve('shot-error.log'), `${text}\n`)
  } catch {
    /* nothing else we can do */
  }
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
}

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

async function capture() {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) throw new Error('no displays reported')
  for (const d of displays) {
    console.log(
      `display id=${d.id} primary=${d.id === screen.getPrimaryDisplay().id} ` +
        `bounds=${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height} ` +
        `work=${d.workArea.x},${d.workArea.y},${d.workArea.width}x${d.workArea.height} ` +
        `scale=${d.scaleFactor}`,
    )
  }

  const primary = screen.getPrimaryDisplay()
  const target = displays.find((d) => d.id === primary.id) ?? displays[0]
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(target.bounds.width * target.scaleFactor),
      height: Math.round(target.bounds.height * target.scaleFactor),
    },
  })
  const source = sources.find((s) => s.display_id === String(target.id)) ?? sources[0]
  if (!source) throw new Error('no screen source available')

  const argOut = process.argv.filter((a) => a.toLowerCase().endsWith('.png')).pop()
  const out = path.resolve(argOut ?? 'shot.png')
  writeFileSync(out, source.thumbnail.toPNG())
  const size = source.thumbnail.getSize()
  console.log(`wrote ${out} (${size.width}x${size.height})`)
  app.exit(0)
}

if (typeof app?.whenReady !== 'function') {
  fail(new Error('this script must be run by Electron, not by node'))
} else {
  app.whenReady().then(capture).catch(fail)
}
