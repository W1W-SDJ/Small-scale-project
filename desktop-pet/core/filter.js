'use strict'

// The "your needs" half of the app: topic keyword sets, relevance scoring, and a
// rule-based summary that works with zero network calls and zero API keys.
//
// Design constraint: this must produce something genuinely useful without an LLM,
// because the pet is meant to be handed to other people as a plain exe. The trick
// is to stop trying to paraphrase and instead extract what a reader actually
// needs to act on: what it is, when the deadline is, who to contact.

const DEFAULT_TOPICS = [
  {
    id: 'competition',
    name: '竞赛',
    color: '#f6a94a',
    keywords: ['竞赛', '比赛', '大赛', '赛项', '参赛', '赛道', '报名', '获奖', '决赛', '初赛', '复赛', '挑战杯', '创新创业', '工创赛', '建模', '选拔'],
  },
  {
    id: 'job',
    name: '实习招聘',
    color: '#4fd1a5',
    keywords: ['招聘', '校招', '实习', '宣讲', '简历', '岗位', '面试', '就业', '双选会', '人才', '聘用', '劳务', '科研助理'],
  },
  {
    id: 'ai',
    name: 'AI 技术',
    color: '#7aa8ff',
    keywords: ['人工智能', 'AI', '大模型', '机器学习', '深度学习', '神经网络', '算法', '智能体', 'LLM', 'GPT', 'transformer', '机器人', '具身', '算力', '开源', '前沿'],
  },
  {
    id: 'grad',
    name: '保研招生',
    color: '#f487c0',
    keywords: ['推免', '保研', '夏令营', '研究生', '招生', '复试', '调剂', '博士', '硕士', '导师', '面试'],
  },
  {
    id: 'notice',
    name: '校内通知',
    color: '#a78bfa',
    keywords: ['通知', '公告', '公示', '截止', '申报', '评选', '奖学金', '助学金', '资助', '学籍', '考试', '成绩', '选课', '培养方案', '毕业', '学位'],
  },
]

/** Words that mark something actionable. A title hit here is worth a bonus. */
const ACTIONABLE = /截止|报名|申报|申请|开始|开放|启动|招募|招聘|公示|公示期|时间安排|会议通知|培训|讲座|论坛/

const DEADLINE_RE =
  /(?:截止(?:日期|时间)?|报名截止|申请截止|须于|请于|于|截至)\s*[:：]?\s*((?:20\d{2}\s*年)?\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*\d{1,2}\s*[:：]\s*\d{2})?|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/

const CONTACT_RE =
  /((?:[\w.+-]+@[\w-]+\.[\w.-]{2,})|(?:(?:电话|联系方式|咨询电话|联系人)\s*[:：]\s*[^\n。；，,]{2,40}))/

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Count keyword hits. ASCII-only keywords (AI, LLM, GPT) must not match inside
 * other words, so they get boundary checks; Chinese keywords are matched as-is.
 */
function countHits(text, keywords) {
  if (!text) return 0
  let hits = 0
  for (const keyword of keywords) {
    if (!keyword) continue
    if (/^[\x20-\x7e]+$/.test(keyword)) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(keyword)}(?![A-Za-z0-9])`, 'gi')
      const found = text.match(re)
      if (found) hits += Math.min(found.length, 2)
    } else if (text.includes(keyword)) {
      hits += 1
    }
  }
  return hits
}

/** Which topics does this item belong to, and how strongly? */
function matchTopics(item, topics) {
  const title = item.title || ''
  const body = item.body || ''
  const summary = item.summary || ''
  const haystack = `${summary}\n${body}`
  const matched = []
  let score = 0

  for (const topic of topics) {
    if (topic.enabled === false) continue
    const titleHits = countHits(title, topic.keywords)
    const bodyHits = countHits(haystack, topic.keywords)
    if (titleHits === 0 && bodyHits === 0) continue
    const points = titleHits * 3 + Math.min(bodyHits, 4)
    score += points
    matched.push({ id: topic.id, name: topic.name, color: topic.color, points, titleHits })
  }

  if (ACTIONABLE.test(title)) score += 2
  if (DEADLINE_RE.test(body)) score += 1

  matched.sort((a, b) => b.points - a.points)
  return { score, matched }
}

/** Recency bonus in points; also used for sorting ties. */
function recencyBoost(date, now = Date.now()) {
  if (!date) return 0
  const time = new Date(`${date}T00:00:00`).getTime()
  if (!Number.isFinite(time)) return 0
  const days = (now - time) / 86400000
  if (days < 0) return 1 // a future date means we probably mis-parsed; do not boost
  if (days <= 7) return 3
  if (days <= 30) return 2
  if (days <= 120) return 1
  return 0
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 8)
}

/**
 * Rule summary: lead sentence + the most actionable sentences, capped.
 * Deliberately extractive — every sentence is copied from the source, so the
 * summary can never invent a deadline or a contact address.
 */
function ruleSummary(title, body, maxLength = 150) {
  const sentences = splitSentences(body)
  if (!sentences.length) return ''

  const picked = []
  const push = (sentence) => {
    const clean = sentence.replace(/\s+/g, ' ').trim()
    if (clean.length < 8) return
    if (picked.some((existing) => existing.includes(clean.slice(0, 12)))) return
    picked.push(clean)
  }

  const titleHead = String(title || '').slice(0, 12)
  const first = sentences[0].includes(titleHead) ? sentences[1] : sentences[0]
  if (first) push(first)

  const weighted = []
  for (const sentence of sentences.slice(1, 60)) {
    if (sentence === first) continue
    let weight = 0
    if (DEADLINE_RE.test(sentence)) weight += 3
    if (CONTACT_RE.test(sentence)) weight += 1
    if (/报名|申请|资格|条件|要求|对象|名额|材料|流程|方式|时间|地点/.test(sentence)) weight += 2
    if (sentence.length >= 20 && sentence.length <= 80) weight += 1
    if (weight > 0) weighted.push({ sentence, weight })
  }
  weighted.sort((a, b) => b.weight - a.weight)
  for (const { sentence } of weighted) {
    if (picked.join('').length >= maxLength) break
    push(sentence)
  }

  if (!picked.length) return sentences.slice(0, 2).join(' ').slice(0, maxLength)

  let summary = picked.join(' ')
  if (summary.length > maxLength) {
    summary = summary.slice(0, maxLength).replace(/[\s，,；;、]+$/, '') + '…'
  }
  return summary
}

function extractDeadline(text) {
  const match = String(text || '').match(DEADLINE_RE)
  if (!match) return null
  return match[1].replace(/\s+/g, '').replace(/^20\d{2}年?[-/.]?/, (prefix) => prefix)
}

function extractContact(text) {
  return String(text || '').match(CONTACT_RE)?.[1]?.trim() || null
}

/** Cheap title fingerprint so the same story from two sites collapses into one. */
function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。．.、；;：:！!？?（）()【】[\]《》<>"'“”‘’\-—_/\\|·~`]/g, '')
    .slice(0, 26)
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|from|spm|share)/i.test(key)) parsed.searchParams.delete(key)
    }
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return String(url || '')
  }
}

module.exports = {
  DEFAULT_TOPICS,
  ACTIONABLE,
  DEADLINE_RE,
  CONTACT_RE,
  countHits,
  matchTopics,
  recencyBoost,
  ruleSummary,
  extractDeadline,
  extractContact,
  titleKey,
  normalizeUrl,
  splitSentences,
}
