'use strict'

// Skin registry.
//
// A skin is a directory holding `pet.png` plus an optional `meta.json`
// ({"name": "..."}). Built-in skins ship inside the app under assets/skins/;
// imported ones live in the user's own data directory so that sharing the app
// never leaks somebody else's pictures, and reinstalling never loses them.

const fs = require('node:fs')
const path = require('node:path')

const ASSET_DIR = path.join(__dirname, '..', 'assets')
const BUILTIN_ROOT = path.join(ASSET_DIR, 'skins')

/** A sprite must be a real PNG and big enough to be a pet. */
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MIN_SIDE = 48

/** Curated order for the built-ins so the picker does not reshuffle per launch. */
const BUILTIN_ORDER = ['blob', 'whale-musume']

function readPngSize(buffer) {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null // \x89PNG
  if (buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

function pngSizeOf(file) {
  try {
    return readPngSize(fs.readFileSync(file))
  } catch {
    return null
  }
}

function readMeta(dir, fallbackName) {
  try {
    // Windows editors (PowerShell's Set-Content among them) happily write a UTF-8
    // BOM, which makes JSON.parse throw — and the skin would silently lose its
    // display name. Strip it before parsing.
    const raw = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8').replace(/^\uFEFF/, '')
    const meta = JSON.parse(raw)
    return {
      name: String(meta.name || fallbackName).slice(0, 24),
      addedAt: meta.addedAt || null,
    }
  } catch {
    return { name: fallbackName, addedAt: null }
  }
}

function createSkinStore(userRoot) {
  const listDir = (root, source) => {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    const skins = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      const file = path.join(dir, 'pet.png')
      const size = pngSizeOf(file)
      if (!size) continue
      const meta = readMeta(dir, entry.name)
      skins.push({
        id: source === 'user' ? `user:${entry.name}` : entry.name,
        name: meta.name,
        source,
        file,
        width: size.width,
        height: size.height,
        addedAt: meta.addedAt,
      })
    }
    return skins.sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')) || a.name.localeCompare(b.name))
  }

  /** The sprite that shipped with v1 lives at assets/pet.png; keep it as skin #1. */
  const legacy = () => {
    const file = path.join(ASSET_DIR, 'pet.png')
    const size = pngSizeOf(file)
    if (!size) return null
    return { id: 'blob', name: '奶蛙', source: 'builtin', file, width: size.width, height: size.height, addedAt: null }
  }

  return {
    list() {
      const builtin = listDir(BUILTIN_ROOT, 'builtin')
      const first = legacy()
      const all = first ? [first, ...builtin.filter((skin) => skin.id !== 'blob')] : builtin
      const rank = (skin) => {
        const index = BUILTIN_ORDER.indexOf(skin.id)
        return index === -1 ? BUILTIN_ORDER.length : index
      }
      const ordered = [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh'))
      return [...ordered, ...listDir(userRoot, 'user')]
    },

    find(id) {
      return this.list().find((skin) => skin.id === id) || null
    },

    /** Falls back to the first available skin so a deleted skin cannot brick the pet. */
    resolve(id) {
      const skins = this.list()
      return skins.find((skin) => skin.id === id) || skins[0] || null
    },

    /** Store an imported sprite (bytes already decoded by the caller). */
    importBuffer(buffer, name) {
      const size = readPngSize(buffer)
      if (!size) throw new Error('不是有效的 PNG 文件')
      if (buffer.length > MAX_FILE_BYTES) throw new Error('图片太大（上限 12 MB）')
      if (size.width < MIN_SIDE || size.height < MIN_SIDE) throw new Error('图片太小（至少 48×48）')

      const stamp = new Date()
      const id = `skin-${stamp.getTime().toString(36)}`
      const dir = path.join(userRoot, id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'pet.png'), buffer)
      const label = String(name || '导入的皮肤').replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '').trim().slice(0, 24) || '导入的皮肤'
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: label, addedAt: stamp.toISOString() }, null, 2))

      return { id: `user:${id}`, name: label, source: 'user', file: path.join(dir, 'pet.png'), ...size, addedAt: stamp.toISOString() }
    },

    remove(id) {
      if (!String(id).startsWith('user:')) throw new Error('内置皮肤不能删除')
      const dir = path.join(userRoot, String(id).slice('user:'.length))
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    },

    /** Data URL for the renderer: file:// images would taint the mask canvas. */
    dataUrl(skin) {
      const buffer = fs.readFileSync(skin.file)
      return `data:image/png;base64,${buffer.toString('base64')}`
    },
  }
}

module.exports = { createSkinStore, readPngSize, pngSizeOf, BUILTIN_ROOT }
