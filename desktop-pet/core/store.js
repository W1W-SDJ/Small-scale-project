'use strict'

// Persistence: one JSON file for the digest, one for the config, one for window
// state. Writes are atomic (temp file + rename) because a crash mid-write would
// otherwise leave the pet with an unparseable digest and no way to recover.

const fs = require('node:fs')
const path = require('node:path')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, file)
}

function createStore(dir) {
  const digestFile = path.join(dir, 'digest.json')
  const configFile = path.join(dir, 'config.json')
  const stateFile = path.join(dir, 'pet-state.json')

  let digest = readJson(digestFile, null)
  if (!digest || !Array.isArray(digest.items)) {
    digest = { items: [], lastRun: null, lastError: null, totalSeen: 0 }
  }

  return {
    dir,
    digestFile,
    configFile,
    stateFile,

    getDigest() {
      return digest
    },

    items() {
      return digest.items
    },

    /** Newest-first list for display. */
    sorted() {
      return [...digest.items].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        if (b.score !== a.score) return b.score - a.score
        return String(b.date || '').localeCompare(String(a.date || '')) || String(b.firstSeen).localeCompare(String(a.firstSeen))
      })
    },

    unreadCount() {
      return digest.items.filter((item) => !item.read).length
    },

    has(url) {
      const key = String(url)
      return digest.items.some((item) => item.id === key || item.url === key)
    },

    hasTitleKey(key) {
      return digest.items.some((item) => item.titleKey === key)
    },

    add(item, { limit = 300 } = {}) {
      const existing = digest.items.find((entry) => entry.id === item.id)
      if (existing) return { added: false, item: existing }
      digest.items.push(item)
      if (digest.items.length > limit) {
        // Drop the oldest read items first so the cap never evicts unread news.
        const removable = digest.items
          .filter((entry) => entry.read && !entry.pinned)
          .sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)))
        const overflow = digest.items.length - limit
        const dropIds = new Set(removable.slice(0, overflow).map((entry) => entry.id))
        digest.items = digest.items.filter((entry) => !dropIds.has(entry.id))
        // Still over the cap (everything unread): drop the oldest anyway.
        if (digest.items.length > limit) {
          digest.items = digest.items
            .sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)))
            .slice(0, limit)
        }
      }
      digest.totalSeen = (digest.totalSeen || 0) + 1
      return { added: true, item }
    },

    markRead(ids) {
      const wanted = new Set(ids)
      for (const item of digest.items) {
        if (!wanted.size || wanted.has(item.id)) item.read = true
      }
      return this.save()
    },

    remove(id) {
      digest.items = digest.items.filter((item) => item.id !== id)
      return this.save()
    },

    clear() {
      digest = { items: [], lastRun: null, lastError: null, totalSeen: 0 }
      return this.save()
    },

    setRun({ lastRun, lastError }) {
      if (lastRun !== undefined) digest.lastRun = lastRun
      if (lastError !== undefined) digest.lastError = lastError
      return this.save()
    },

    save() {
      try {
        writeJson(digestFile, digest)
        return true
      } catch {
        return false
      }
    },

    readConfig(defaults) {
      const { mergeConfig } = require('./config')
      return mergeConfig(readJson(configFile, null) || defaults)
    },

    writeConfig(config) {
      writeJson(configFile, config)
      return config
    },

    readState() {
      return readJson(stateFile, {})
    },

    writeState(patch) {
      try {
        writeJson(stateFile, { ...readJson(stateFile, {}), ...patch })
      } catch {
        /* a pet that forgets its spot is still a working pet */
      }
    },
  }
}

module.exports = { createStore, readJson, writeJson, ensureDir }
