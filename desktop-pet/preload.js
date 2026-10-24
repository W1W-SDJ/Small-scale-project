'use strict'

// The renderers get a small, explicit verb list: no node, no module access, and
// no way to ask for the API key back. Both windows share this preload.

const { contextBridge, ipcRenderer } = require('electron')

const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {}
  const handler = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('pet', {
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  activate: () => ipcRenderer.send('pet:activate'),
  openSkins: () => ipcRenderer.send('pet:open-skins'),
  quit: () => ipcRenderer.send('pet:quit'),
  // A desktop pet has no console anyone can open; renderer breadcrumbs go to the
  // same diagnostic log the main process writes.
  log: (message) => ipcRenderer.send('app:log', String(message).slice(0, 400)),
  skin: () => ipcRenderer.invoke('skin:current'),
  onSkin: (callback) => subscribe('pet:skin', callback),
})

contextBridge.exposeInMainWorld('feed', {
  snapshot: () => ipcRenderer.invoke('feed:snapshot'),
  refresh: () => ipcRenderer.invoke('feed:refresh'),
  addUrl: (url) => ipcRenderer.invoke('feed:add-url', url),
  open: (url) => ipcRenderer.invoke('feed:open', url),
  markRead: (ids) => ipcRenderer.invoke('feed:mark-read', ids),
  remove: (id) => ipcRenderer.invoke('feed:remove', id),
  clear: () => ipcRenderer.invoke('feed:clear'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  testLlm: (patch) => ipcRenderer.invoke('settings:test-llm', patch),
  closePanel: () => ipcRenderer.send('panel:close'),
  // Quitting from the panel is the escape hatch for a wedged pet window: the pet
  // is deliberately non-activatable, so if its in-window menu gets stuck there is
  // no other way to reach the app. The panel is an ordinary focusable window.
  quitApp: () => ipcRenderer.send('app:quit'),
  // Skins are applied by the main process (it also resizes the pet window); the
  // panel only ever sends an id or already-prepared PNG bytes.
  skins: () => ipcRenderer.invoke('skin:list'),
  applySkin: (id) => ipcRenderer.invoke('skin:apply', id),
  importSkin: (payload) => ipcRenderer.invoke('skin:import', payload),
  removeSkin: (id) => ipcRenderer.invoke('skin:remove', id),
  onSnapshot: (callback) => subscribe('feed:snapshot', callback),
  onStatus: (callback) => subscribe('feed:status', callback),
  onNew: (callback) => subscribe('feed:new', callback),
  onSection: (callback) => subscribe('panel:section', callback),
})
