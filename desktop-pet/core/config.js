'use strict'

// Defaults and config merging. Everything the user can tune lives in one JSON
// file next to the digest, so a shared copy of the exe starts from the same
// defaults and each person's edits stay on their own machine.

const { DEFAULT_TOPICS } = require('./filter')

const DEFAULT_SITES = [
  {
    id: 'cau-tzgg',
    name: '校网通知公告',
    url: 'https://www.cau.edu.cn/tzgg/index.htm',
    enabled: true,
    note: '全校性通知、公示、招聘与申报',
  },
  {
    id: 'cau-news',
    name: '校园新闻网',
    url: 'https://news.cau.edu.cn/',
    enabled: true,
    note: '校内要闻、科研动态',
  },
  {
    id: 'cau-coe',
    name: '工学院',
    url: 'https://coe.cau.edu.cn/',
    enabled: true,
    note: '学院通知与就业信息',
  },
  {
    id: 'cau-jwc',
    name: '本科生院',
    url: 'https://jwc.cau.edu.cn/',
    enabled: true,
    note: '教学、学籍、选课类通知',
  },
  {
    id: 'saikr',
    name: '赛氪（竞赛）',
    url: 'https://www.saikr.com/',
    enabled: false,
    note: '校外竞赛聚合，默认关闭',
  },
  {
    id: 'hn',
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    enabled: false,
    note: '英文技术资讯，默认关闭',
  },
]

const DEFAULT_CONFIG = {
  version: 2,
  intervalMinutes: 60,
  minScore: 3,
  maxAgeDays: 400,
  maxItemsPerSource: 8,
  maxDetailFetches: 36,
  skin: 'blob',
  sites: DEFAULT_SITES,
  topics: DEFAULT_TOPICS,
  extraKeywords: [],
  llm: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    note: '留空则完全使用本地规则摘要。填入任意 OpenAI 兼容接口的地址与 key 即可启用。',
  },
  ui: {
    bubble: true,
    panelWidth: 392,
    panelHeight: 560,
    maxCards: 60,
  },
}

const clone = (value) => JSON.parse(JSON.stringify(value))

/** Merge saved config over defaults, section by section, keeping unknown keys. */
function mergeConfig(saved) {
  const base = clone(DEFAULT_CONFIG)
  if (!saved || typeof saved !== 'object') return base

  const merged = { ...base, ...saved }
  merged.sites = mergeSites(saved.sites, base.sites)
  merged.topics = mergeTopics(saved.topics, base.topics)
  merged.llm = { ...base.llm, ...(saved.llm || {}) }
  merged.ui = { ...base.ui, ...(saved.ui || {}) }
  merged.startedAt = saved.startedAt || new Date().toISOString()
  return merged
}

function mergeSites(savedSites, defaultSites) {
  if (!Array.isArray(savedSites) || !savedSites.length) return clone(defaultSites)
  return savedSites
    .filter((site) => site && typeof site.url === 'string' && /^https?:\/\//i.test(site.url))
    .map((site, index) => ({
      id: site.id || `custom-${index}`,
      name: site.name || hostOf(site.url) || '自定义站点',
      url: site.url,
      enabled: site.enabled !== false,
      note: site.note || '',
    }))
}

function mergeTopics(savedTopics, defaultTopics) {
  if (!Array.isArray(savedTopics) || !savedTopics.length) return clone(defaultTopics)
  const byId = new Map(defaultTopics.map((topic) => [topic.id, topic]))
  const merged = savedTopics
    .filter((topic) => topic && typeof topic.id === 'string')
    .map((topic) => {
      const fallback = byId.get(topic.id) || {}
      return {
        id: topic.id,
        name: topic.name || fallback.name || topic.id,
        color: topic.color || fallback.color || '#8ab4f8',
        keywords: Array.isArray(topic.keywords) && topic.keywords.length ? topic.keywords : fallback.keywords || [],
        enabled: topic.enabled !== false,
      }
    })
  // A topic the user removed from the file stays removed; a topic added in a later
  // release is appended so upgrades do not silently drop new capabilities.
  const known = new Set(merged.map((topic) => topic.id))
  for (const topic of defaultTopics) {
    if (!known.has(topic.id)) merged.push(clone(topic))
  }
  return merged
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Effective keyword list: enabled topics plus the user's free-form extras. */
function effectiveTopics(config) {
  const extra = (config.extraKeywords || []).map((word) => String(word).trim()).filter(Boolean)
  const topics = config.topics.map((topic) => ({ ...topic }))
  if (extra.length) {
    topics.push({ id: 'custom', name: '自定义', color: '#d4c48b', keywords: extra, enabled: true })
  }
  return topics.filter((topic) => topic.enabled !== false && topic.keywords.length)
}

module.exports = { DEFAULT_CONFIG, DEFAULT_SITES, mergeConfig, effectiveTopics, hostOf }
