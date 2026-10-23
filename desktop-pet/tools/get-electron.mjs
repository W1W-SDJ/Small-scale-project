// Download the Electron release archive directly and unpack it into
// node_modules/electron/dist, which is what `npm install electron` would have
// done. Used because the package's own install script hangs on this machine.
//
//   node tools/get-electron.mjs
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const electronDir = path.resolve('node_modules/electron')
const version = JSON.parse(readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const file = `electron-v${version}-win32-${arch}.zip`
const mirrors = [
  `https://npmmirror.com/mirrors/electron/${version}/${file}`,
  `https://github.com/electron/electron/releases/download/v${version}/${file}`,
]
const cache = path.resolve('.electron-cache')
mkdirSync(cache, { recursive: true })
const zip = path.join(cache, file)

console.log(`electron ${version} (${arch})`)

if (!existsSync(zip)) {
  let lastError
  for (const url of mirrors) {
    try {
      console.log(`downloading ${url}`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      let seen = 0
      let mark = 0
      const body = Readable.fromWeb(res.body)
      body.on('data', (chunk) => {
        seen += chunk.length
        if (seen - mark > 10 * 1024 * 1024) {
          mark = seen
          console.log(`  ${(seen / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`)
        }
      })
      await pipeline(body, createWriteStream(zip))
      console.log(`  done: ${(seen / 1048576).toFixed(1)} MB`)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      console.log(`  failed: ${error.message}`)
      rmSync(zip, { force: true })
    }
  }
  if (lastError) throw lastError
} else {
  console.log(`using cached ${zip}`)
}

const dist = path.join(electronDir, 'dist')
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
console.log('extracting...')
execFileSync('tar.exe', ['-xf', zip, '-C', dist], { stdio: 'inherit' })
writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe')
console.log(`wrote ${path.join(electronDir, 'path.txt')}`)
console.log(`electron.exe present: ${existsSync(path.join(dist, 'electron.exe'))}`)
