'use strict'

// Digest panel renderer: the card list, the "paste a link" box, and settings.
// All network and file access stays in the main process; this file only draws.

const listEl = document.getElementById('list')
const lastRunEl = document.getElementById('last-run')
const dotEl = document.getElementById('dot')
const countsEl = document.getElementById('counts')
const statusEl = document.getElementById('status')
const refreshBtn = document.getElementById('refresh')
const settingsEl = document.getElementById('settings')

const urlInput = document.getElementById('url-input')
const addUrlBtn = document.getElementById('add-url')

let snapshot = { items: [], unread: 0, total: 0, lastRun: null, settings: null }
let itemsById = new Map()
let draft = null
let statusTimer = null

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

function relativeRun(iso) {
  if (!iso) return '还没刷新'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '还没刷新'
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 1) return '刚刚刷新'
  if (minutes < 60) return `${minutes} 分钟前刷新`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前刷新`
  return `${Math.round(hours / 24)} 天前刷新`
}

function shortDate(date) {
  if (!date) return ''
  const [year, month, day] = String(date).split('-')
  if (!year) return date
  if (month && day) return Number(year) === new Date().getFullYear() ? `${month}-${day}` : `${year}-${month}`
  return String(date)
}

function showStatus(message, { error = false, hideAfter = 0 } = {}) {
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  statusEl.textContent = message
  statusEl.classList.toggle('error', Boolean(error))
  statusEl.hidden = false
  if (hideAfter) statusTimer = setTimeout(() => (statusEl.hidden = true), hideAfter)
}

function renderCards() {
  const items = snapshot.items || []
  itemsById = new Map(items.map((item) => [item.id, item]))

  if (!items.length) {
    listEl.innerHTML = `<div class="empty"><strong>还没有摘要</strong>点右上角 ⟳ 抓取一次，<br />或者在上面粘贴一个链接让我立刻摘一份。</div>`
    return
  }

  listEl.innerHTML = items
    .map((item) => {
      const chips = (item.matched || [])
        .slice(0, 3)
        .map((topic) => `<span class="chip" style="color:${esc(topic.color || '#8ab4f8')}">${esc(topic.name)}</span>`)
        .join('')
      const classes = ['card']
      if (!item.read) classes.push('unread')
      if (item.pinned) classes.push('pinned')
      const deadline = item.deadline ? `<span class="pill">截止 ${esc(item.deadline)}</span>` : ''
      return `
        <article class="${classes.join(' ')}" data-id="${esc(item.id)}">
          <button class="dismiss" title="从列表移除">✕</button>
          <div class="card-head">
            <span class="chips">${chips}</span>
            <span class="date">${esc(shortDate(item.date))}</span>
          </div>
          <h3>${esc(item.title)}</h3>
          ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ''}
          <div class="card-foot">
            <span class="source">${esc(item.sourceName || '')}</span>
            ${deadline}
            <span class="open-link">原文 ↗</span>
          </div>
        </article>`
    })
    .join('')
}

function render() {
  lastRunEl.textContent = relativeRun(snapshot.lastRun)
  countsEl.textContent = `${snapshot.total ?? snapshot.items.length} 条 · ${snapshot.unread} 未读`
  dotEl.classList.toggle('busy', Boolean(snapshot.refreshing))
  dotEl.classList.toggle('error', Boolean(snapshot.lastError) && !snapshot.refreshing)
  refreshBtn.classList.toggle('spinning', Boolean(snapshot.refreshing))
  refreshBtn.disabled = Boolean(snapshot.refreshing)
  addUrlBtn.disabled = Boolean(snapshot.refreshing)
  renderCards()
}

function applySnapshot(next) {
  if (!next) return
  snapshot = { ...snapshot, ...next }
  render()
  if (draft && !settingsEl.classList.contains('open')) draft = null
}

// --- list interaction -----------------------------------------------------

listEl.addEventListener('click', (event) => {
  const dismiss = event.target.closest('.dismiss')
  const card = event.target.closest('.card')
  if (!card) return
  const item = itemsById.get(card.dataset.id)
  if (!item) return
  if (dismiss) {
    card.style.opacity = '0.4'
    window.feed.remove(item.id)
    return
  }
  window.feed.open(item.url)
  if (!item.read) {
    card.classList.remove('unread')
    window.feed.markRead([item.id])
  }
})

document.getElementById('mark-all').addEventListener('click', () => window.feed.markRead([]))

refreshBtn.addEventListener('click', () => {
  if (snapshot.refreshing) return
  window.feed.refresh()
})

const closeButton = document.getElementById('close')
closeButton.addEventListener('click', () => {
  window.pet.log('panel close: button')
  window.feed.closePanel()
})

// --- quick add ------------------------------------------------------------

async function addUrl() {
  const value = urlInput.value.trim()
  if (!value) {
    showStatus('先粘贴一个链接', { error: true, hideAfter: 4000 })
    return
  }
  addUrlBtn.disabled = true
  addUrlBtn.textContent = '抓取…'
  showStatus('正在抓取这一页…')
  try {
    const result = await window.feed.addUrl(value)
    if (result.ok) {
      urlInput.value = ''
      showStatus(`已添加：${result.item.title}`, { hideAfter: 6000 })
    } else {
      showStatus(result.error || '抓取失败', { error: true, hideAfter: 8000 })
    }
  } finally {
    addUrlBtn.disabled = false
    addUrlBtn.textContent = '添加'
  }
}

addUrlBtn.addEventListener('click', addUrl)
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addUrl()
})

// --- settings -------------------------------------------------------------

const intervalEl = document.getElementById('interval')
const siteListEl = document.getElementById('site-list')
const topicListEl = document.getElementById('topic-list')
const extraEl = document.getElementById('extra-keywords')
const llmEnabledEl = document.getElementById('llm-enabled')
const llmBaseEl = document.getElementById('llm-base')
const llmModelEl = document.getElementById('llm-model')
const llmKeyEl = document.getElementById('llm-key')
const llmTestResultEl = document.getElementById('llm-test-result')

function renderSiteChecklist() {
  siteListEl.innerHTML = draft.sites
    .map(
      (site, index) => `
      <div class="check-item" data-index="${index}">
        <input type="checkbox" ${site.enabled ? 'checked' : ''} data-role="toggle" />
        <span class="name">${esc(site.name)}</span>
        <span class="meta">${esc(site.note || site.url)}</span>
        <button class="mini danger" data-role="remove" title="删除">×</button>
      </div>`,
    )
    .join('')
}

function renderTopicChecklist() {
  topicListEl.innerHTML = draft.topics
    .map(
      (topic, index) => `
      <div class="check-item" data-index="${index}">
        <input type="checkbox" ${topic.enabled ? 'checked' : ''} data-role="toggle" />
        <span class="swatch" style="background:${esc(topic.color)}"></span>
        <span class="name">${esc(topic.name)}</span>
        <span class="meta">${topic.keywords.length} 个词</span>
      </div>`,
    )
    .join('')
}

function fillSettingsForm() {
  const settings = snapshot.settings
  if (!settings) return
  draft = {
    sites: JSON.parse(JSON.stringify(settings.sites || [])),
    topics: JSON.parse(JSON.stringify(settings.topics || [])),
    extraKeywords: [...(settings.extraKeywords || [])],
    llm: { ...(settings.llm || {}) },
  }
  const interval = String(settings.intervalMinutes || 60)
  if (![...intervalEl.options].some((option) => option.value === interval)) {
    const option = document.createElement('option')
    option.value = interval
    option.textContent = `每 ${interval} 分钟`
    intervalEl.append(option)
  }
  intervalEl.value = interval
  extraEl.value = (settings.extraKeywords || []).join(', ')
  llmEnabledEl.checked = Boolean(settings.llm?.enabled)
  llmBaseEl.value = settings.llm?.baseUrl || ''
  llmModelEl.value = settings.llm?.model || ''
  llmKeyEl.value = ''
  llmKeyEl.placeholder = settings.llm?.hasKey ? '已保存 key（留空则不修改）' : '留空 = 继续用本地规则摘要'
  llmTestResultEl.textContent = ''
  llmTestResultEl.className = 'test-result'
  renderSiteChecklist()
  renderTopicChecklist()
}

function openSettings(section) {
  fillSettingsForm()
  settingsEl.hidden = false
  // Chromium keeps the scroll offset of a hidden scroll container across the
  // show transition, which opened the form halfway down. Always start at the top.
  const body = settingsEl.querySelector('.settings-body')
  if (body) body.scrollTop = 0
  requestAnimationFrame(() => {
    settingsEl.classList.add('open')
    if (section === 'skins') {
      const group = document.getElementById('skin-group')
      if (group) group.scrollIntoView({ block: 'start' })
    }
  })
  loadSkins()
}

function closeSettings() {
  settingsEl.classList.remove('open')
  setTimeout(() => {
    settingsEl.hidden = true
  }, 240)
}

document.getElementById('settings-btn').addEventListener('click', () => openSettings())
document.getElementById('settings-close').addEventListener('click', closeSettings)
document.getElementById('settings-cancel').addEventListener('click', closeSettings)

siteListEl.addEventListener('change', (event) => {
  const row = event.target.closest('.check-item')
  if (row && event.target.dataset.role === 'toggle') draft.sites[Number(row.dataset.index)].enabled = event.target.checked
})

siteListEl.addEventListener('click', (event) => {
  if (event.target.dataset.role !== 'remove') return
  const row = event.target.closest('.check-item')
  draft.sites.splice(Number(row.dataset.index), 1)
  renderSiteChecklist()
})

topicListEl.addEventListener('change', (event) => {
  const row = event.target.closest('.check-item')
  if (row && event.target.dataset.role === 'toggle') draft.topics[Number(row.dataset.index)].enabled = event.target.checked
})

document.getElementById('site-add').addEventListener('click', () => {
  const name = document.getElementById('site-name')
  const url = document.getElementById('site-url')
  const value = url.value.trim()
  if (!/^https?:\/\//i.test(value)) {
    showStatus('站点地址要以 http:// 或 https:// 开头', { error: true, hideAfter: 4000 })
    return
  }
  let host = value
  try {
    host = new URL(value).host
  } catch {
    /* keep the raw string as the label */
  }
  draft.sites.push({
    id: `custom-${Date.now()}`,
    name: name.value.trim() || host,
    url: value,
    enabled: true,
    note: host,
  })
  name.value = ''
  url.value = ''
  renderSiteChecklist()
})

document.getElementById('settings-save').addEventListener('click', async () => {
  const patch = {
    intervalMinutes: Number(intervalEl.value),
    sites: draft.sites,
    topics: draft.topics,
    extraKeywords: extraEl.value.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean),
    llm: {
      enabled: llmEnabledEl.checked,
      baseUrl: llmBaseEl.value.trim(),
      model: llmModelEl.value.trim(),
    },
  }
  const key = llmKeyEl.value.trim()
  if (key) patch.llm.apiKey = key

  const saved = await window.feed.saveSettings(patch)
  applySnapshot(saved)
  closeSettings()
  showStatus('设置已保存', { hideAfter: 4000 })
})

document.getElementById('llm-test').addEventListener('click', async () => {
  const patch = {
    baseUrl: llmBaseEl.value.trim(),
    model: llmModelEl.value.trim(),
  }
  const key = llmKeyEl.value.trim()
  if (key) patch.apiKey = key
  llmTestResultEl.textContent = '测试中…'
  llmTestResultEl.className = 'test-result'
  const result = await window.feed.testLlm(patch)
  llmTestResultEl.textContent = result.ok ? `可用：${result.message}` : `失败：${result.message}`
  llmTestResultEl.className = `test-result ${result.ok ? 'ok' : 'bad'}`
})

document.getElementById('btn-refresh2').addEventListener('click', () => {
  closeSettings()
  window.feed.refresh()
})

document.getElementById('btn-clear').addEventListener('click', async () => {
  const next = await window.feed.clear()
  applySnapshot(next)
  showStatus('摘要已清空', { hideAfter: 4000 })
})

document.getElementById('btn-reset').addEventListener('click', async () => {
  const next = await window.feed.resetSettings()
  applySnapshot(next)
  fillSettingsForm()
  showStatus('已恢复默认设置', { hideAfter: 4000 })
})

// --- skins ----------------------------------------------------------------

const skinGridEl = document.getElementById('skin-grid')
const skinImportBtn = document.getElementById('skin-import')
const skinFileEl = document.getElementById('skin-file')
const skinStatusEl = document.getElementById('skin-status')
const dropHintEl = document.getElementById('drop-hint')

let skinsState = { current: null, skins: [] }

function renderSkins() {
  const { current, skins } = skinsState
  if (!skins.length) {
    skinGridEl.innerHTML = '<div class="hint">没有找到任何皮肤。</div>'
    return
  }
  skinGridEl.innerHTML = skins
    .map((skin) => {
      const active = skin.id === current ? ' active' : ''
      const remove =
        skin.source === 'user' ? `<button class="remove" data-remove="${esc(skin.id)}" title="删除这个皮肤">✕</button>` : ''
      return `
        <div class="skin-item${active}" data-id="${esc(skin.id)}" title="${esc(skin.name)}">
          ${remove}
          <img src="${esc(skin.url)}" alt="" />
          <span class="label">${esc(skin.name)}</span>
        </div>`
    })
    .join('')
}

async function loadSkins() {
  try {
    skinsState = await window.feed.skins()
    renderSkins()
  } catch (error) {
    skinStatusEl.textContent = `读取皮肤失败：${error.message}`
    skinStatusEl.className = 'test-result bad'
  }
}

function skinMessage(text, bad) {
  skinStatusEl.textContent = text
  skinStatusEl.className = `test-result ${bad ? 'bad' : 'ok'}`
}

/**
 * Turn any picture into a pet-ready PNG: downscale, cut the background away,
 * remove decorations, and trim to the subject. Done here because only the canvas
 * can decode JPEG/WebP without a dependency, and only the renderer can read the
 * pixels back (a data: URL keeps the canvas untainted).
 */
async function prepareSpriteFile(file) {
  if (!file) throw new Error('没有拿到文件')
  if (file.type && !file.type.startsWith('image/')) throw new Error('这不是图片文件')

  const bitmap = await createImageBitmap(file)
  const MAX_SIDE = 900
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0, width, height)
  if (bitmap.close) bitmap.close()

  const prepared = window.SkinPrep.prepareSprite(context.getImageData(0, 0, width, height))
  const image = prepared.image

  const output = document.createElement('canvas')
  output.width = image.width
  output.height = image.height
  output.getContext('2d').putImageData(image, 0, 0)

  return {
    dataUrl: output.toDataURL('image/png'),
    width: image.width,
    height: image.height,
    method: prepared.method,
    dropped: prepared.dropped,
  }
}

const METHOD_LABELS = {
  'as-is': '图片本身已透明，原样使用',
  'white-background': '已自动去白底',
  'scene-background': '已自动去场景背景',
}

async function importSkinFromFile(file) {
  skinMessage('正在处理图片…')
  try {
    const prepared = await prepareSpriteFile(file)
    if (prepared.width < 48 || prepared.height < 48) throw new Error('图片太小了，至少 48×48')
    const result = await window.feed.importSkin({ name: file.name, dataUrl: prepared.dataUrl })
    if (!result.ok) throw new Error(result.error || '导入失败')
    skinsState = { current: result.current, skins: result.skins }
    renderSkins()
    skinMessage(`已导入并换上：${prepared.width}×${prepared.height}（${METHOD_LABELS[prepared.method] || prepared.method}）`, false)
  } catch (error) {
    skinMessage(`导入失败：${error.message}`, true)
  }
}

skinGridEl.addEventListener('click', async (event) => {
  const removeId = event.target.dataset?.remove
  if (removeId) {
    event.stopPropagation()
    const result = await window.feed.removeSkin(removeId)
    if (result.ok) {
      skinsState = { current: result.current, skins: result.skins }
      renderSkins()
      skinMessage('已删除这个皮肤', false)
    } else {
      skinMessage(`删除失败：${result.error}`, true)
    }
    return
  }
  const item = event.target.closest('.skin-item')
  if (!item) return
  const id = item.dataset.id
  if (id === skinsState.current) return
  const result = await window.feed.applySkin(id)
  if (result.ok) {
    skinsState = { current: result.current, skins: result.skins }
    renderSkins()
    const name = result.skins.find((skin) => skin.id === id)?.name || ''
    skinMessage(`已换上「${name}」`, false)
  } else {
    skinMessage(`换不上：${result.error}`, true)
  }
})

skinImportBtn.addEventListener('click', () => skinFileEl.click())
skinFileEl.addEventListener('change', () => {
  const file = skinFileEl.files?.[0]
  skinFileEl.value = ''
  if (file) importSkinFromFile(file)
})

// Drag a picture anywhere onto the panel.
const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files')
document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  dropHintEl.hidden = false
})
document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) dropHintEl.hidden = true
})
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dropHintEl.hidden = true
  const file = event.dataTransfer.files?.[0]
  if (file) importSkinFromFile(file)
})

// --- signals --------------------------------------------------------------

window.feed.onSnapshot(applySnapshot)

window.feed.onSection((payload) => {
  if (payload?.section === 'skins') openSettings('skins')
})

window.feed.onStatus((status) => {
  if (!status) return
  if (status.phase === 'start') {
    showStatus(status.trigger === '手动' ? '正在抓取所有站点…' : '定时抓取中…')
    return
  }
  if (status.phase === 'log') {
    showStatus(status.message)
    return
  }
  if (status.phase === 'done') {
    if (status.errors && status.errors.length) {
      showStatus(`抓取完成，有 ${status.errors.length} 处失败：${status.errors[0]}`, { error: true, hideAfter: 9000 })
    } else if (status.added > 0) {
      showStatus(`新增 ${status.added} 条内容`, { hideAfter: 5000 })
    } else {
      showStatus('没有新内容', { hideAfter: 3500 })
    }
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (settingsEl.classList.contains('open')) closeSettings()
    else {
      window.pet.log('panel close: escape')
      window.feed.closePanel()
    }
  }
  if (event.key === 'F5') {
    event.preventDefault()
    if (!snapshot.refreshing) window.feed.refresh()
  }
})

// Keep "x 分钟前刷新" honest without re-rendering the list.
setInterval(() => {
  lastRunEl.textContent = relativeRun(snapshot.lastRun)
}, 30000)

window.feed.snapshot().then(applySnapshot).catch(() => {})

window.pet.log(`panel loaded ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`)
