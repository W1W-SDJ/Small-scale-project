'use strict'

// The refresh pipeline: list page -> candidates -> detail page -> article ->
// topics -> summary -> digest.
//
// Cost control matters here. Detail pages are the expensive part (one request
// each, ~1s apart per host), so candidates are ranked by how article-like their
// URL is and how recent the date next to them looks, then only unseen ones are
// fetched, under a global budget. A cold first run fills the digest; every run
// after that only pays for genuinely new links.

const { fetchText } = require('./net')
const { extractAnchors, extractArticle, parseDateValue, isoDate, pageTitle } = require('./html')
const { matchTopics, recencyBoost, ruleSummary, extractDeadline, extractContact, titleKey, normalizeUrl } = require('./filter')
const { effectiveTopics } = require('./config')
const { llmSummary } = require('./llm')

const COMPOUND_TLDS = new Set([
  'edu.cn', 'com.cn', 'gov.cn', 'org.cn', 'net.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'com.hk', 'edu.hk', 'com.tw', 'edu.tw',
])

const NAV_LABEL =
  /^(?:首页|首 页|返回|更多|more|上一页|下一页|下载|打印|关闭|收藏|分享|登录|注册|English|中文|网站地图|联系我们|友情链接|学院简介|学院概况|师资队伍|人才培养|科学研究|党建工作|学生工作|校友之家|招生就业|导航|当前位置|您现在的位置)/i

function registrableLoose(host) {
  const parts = String(host).split('.')
  if (parts.length <= 2) return host
  const last2 = parts.slice(-2).join('.')
  return COMPOUND_TLDS.has(last2) ? parts.slice(-3).join('.') : last2
}

function sameSiteFamily(url, pageHost) {
  const host = url.host.toLowerCase()
  const base = pageHost.toLowerCase()
  if (host === base) return true
  const family = registrableLoose(base)
  return host === family || host.endsWith(`.${family}`)
}

function looksLikeArticle(pathname) {
  if (/\/col\/col\d+/i.test(pathname)) return false
  if (/\/[0-9a-f]{16,}\.(?:s?html?|jsp|aspx?|php)$/i.test(pathname)) return 3
  if (/\/art\/\d{4}\//i.test(pathname)) return 3
  if (/\/(?:ttgznew|tzgg|news|content)\//i.test(pathname)) return 2
  if (/\/\d{4}\/\d{1,2}\//i.test(pathname)) return 2
  if (/\/\d{4}\/\d{2}\/\d{2}\//i.test(pathname)) return 3
  if (/\.(?:s?html?)$/i.test(pathname)) return 1
  return 0
}

const FULL_DATE_RE = /20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}|\d{1,2}\s*[/.]\s*\d{1,2}\s*,\s*20\d{2}/g
const MONTH_RE = /20\d{2}\s*[-/.年]\s*(\d{1,2})\s*月?(?![-/.]\d)/g

/**
 * The closest date to an anchor, looking backwards through the list markup.
 *
 * CAU's notice list splits the date across two boxes ("22" then "2026.10"), so a
 * month match alone is not a date — the day has to be dug out of the adjacent
 * markup, otherwise every item on the page reports the 1st of the month.
 */
function dateNear(contextBefore) {
  const window = String(contextBefore || '').slice(-420)
  if (!window) return null

  let full = null
  for (const match of window.matchAll(FULL_DATE_RE)) {
    const iso = parseDateValue(match[0])
    if (iso) full = iso
  }
  if (full) return full

  let monthMatch = null
  for (const match of window.matchAll(MONTH_RE)) monthMatch = match
  if (!monthMatch) return null

  const year = Number(monthMatch[0].match(/20\d{2}/)[0])
  const month = Number(monthMatch[1])
  const before = window.slice(Math.max(0, monthMatch.index - 240), monthMatch.index)
  const after = window.slice(monthMatch.index + monthMatch[0].length, monthMatch.index + monthMatch[0].length + 160)

  const standalone = /(?:>|\s)(\d{1,2})\s*(?:<|\s|$)/g
  let dayBefore = null
  for (const match of before.matchAll(standalone)) dayBefore = Number(match[1])
  let dayAfter = null
  for (const match of after.matchAll(/(?:>|\s)(\d{1,2})\s*(?:<|\s|$)/g)) {
    dayAfter = Number(match[1])
    break
  }
  const day = dayBefore || dayAfter || 1
  return isoDate(year, month, day)
}

/** Date and category prefixes that some templates put in front of the real title. */
const LEADERS = [
  /^\s*\d{1,2}\s*[/.]\s*\d{1,2}\s*,?\s*20\d{2}\s*/, // 10/14, 2026
  /^\s*20\d{2}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{0,2}\s*日?\s*/, // 2026-10-22 / 2026年10月22日
  /^\s*\d{1,2}\s+20\d{2}\s*[-–—.]\s*\d{1,2}\s*月?\s*/, // 22 2026.10
  /^\s*(?:综合通知|学籍通知|学院通知|部门通知|教务通知|通知公告|新闻|要闻|学术|科研|就业|招生|公示|动态|讲座|报告|图片新闻)\s+/,
]

function stripLeaders(input) {
  let text = String(input || '').replace(/\s+/g, ' ').trim()
  let previous
  do {
    previous = text
    for (const re of LEADERS) text = text.replace(re, '')
  } while (text !== previous && text.length > 0)
  return text.trim()
}

/** Strip the category/date prefixes that some templates put inside the <a>. */
function cleanLabel(raw) {
  const label = String(raw || '').replace(/^[【\[]([^】\]]{2,10})[】\]]\s*/, '')
  return stripLeaders(label)
}

/** Rank the anchors on a list page; returns [{url, label, date}] best first. */
function pickCandidates(html, pageUrl, site) {
  const anchors = extractAnchors(html, pageUrl)
  let pageHost = ''
  try {
    pageHost = new URL(pageUrl).host
  } catch {
    return []
  }

  const ranked = new Map()
  for (const anchor of anchors) {
    const label = cleanLabel(anchor.label || anchor.title || '')
    if (label.length < 8) continue
    if (NAV_LABEL.test(label)) continue

    let url
    try {
      url = new URL(anchor.href)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol)) continue
    if (!sameSiteFamily(url, pageHost)) continue
    if (url.pathname === '/' || /\/index\.[a-z]+$/i.test(url.pathname)) continue
    if (/\.(?:pdf|docx?|xlsx?|zip|rar|7z|jpe?g|png|gif|mp4)$/i.test(url.pathname)) continue

    const articleScore = looksLikeArticle(url.pathname)
    if (articleScore === 0) continue

    const date = dateNear(anchor.contextBefore)
    const key = normalizeUrl(url.href)
    const score = articleScore + (date ? 2 : 0) + (label.length > 14 ? 1 : 0)
    const previous = ranked.get(key)
    if (previous && previous.score >= score) continue
    ranked.set(key, { url: url.href, label, date, score })
  }

  return [...ranked.values()].sort((a, b) => b.score - a.score || String(b.date || '').localeCompare(String(a.date || '')))
}

/** Is this dash-separated segment a channel/site suffix rather than part of the title? */
function isSiteish(segment, siteName) {
  const part = String(segment || '').trim()
  if (!part) return true
  if (siteName && part.includes(siteName)) return true
  if (part.length > 16) return false
  return /中国农业大学|新闻网|新闻资讯|通知公告|公示公告|学院公告|工学院|本科生院|研究生院|首页|门户|官网|学校|新闻网/.test(part)
}

/** Channel/site words that templates prepend to a real title, space separated. */
const TITLE_PREFIX =
  /^(?:中国农业大学(?:工学院|本科生院|研究生院|新闻网|校网|后勤保障处|水利与智能工程学院|农学院|动物医学院|资源与环境学院)?|工学院|本科生院|研究生院|新闻网|党建思政|新闻动态|学术动态|新闻资讯|通知公告|信息公开|综合新闻|校园新闻|要闻|动态)\s+/u

/** Strip CMS chrome off a page title: "标题 - 通知公告 - 中国农业大学". */
function cleanTitle(raw, siteName) {
  let title = stripLeaders(String(raw || '').replace(/\s+/g, ' ').trim())
  if (!title) return ''
  // Leading bracket tags ([要闻] [通知]) carry no information of their own.
  title = title.replace(/^[【\[]([^】\]]{2,10})[】\]]\s*/, (match, inner) =>
    /通知|公告|公示|要闻|新闻|学术|讲座|就业|科研/.test(inner) ? '' : match,
  )
  // Space-separated channel prefixes ("中国农业大学工学院 党建思政 关于…").
  for (let guard = 0; guard < 4; guard++) {
    const match = title.match(TITLE_PREFIX)
    if (!match) break
    const rest = title.slice(match[0].length)
    if (rest.length < 6) break
    title = rest
  }
  // Peel site/channel segments off the end, repeatedly ("… - 通知公告 - 中国农业大学").
  for (let guard = 0; guard < 5; guard++) {
    const match = title.match(/^(.*?)\s*[-–—_|]+\s*([^-–—_|]{1,20})$/)
    if (!match) break
    if (!isSiteish(match[2], siteName)) break
    if (match[1].trim().length < 6) break
    title = match[1].trim()
  }
  if (siteName && title.endsWith(siteName)) title = title.slice(0, -siteName.length).trim()
  return title.replace(/^[【\[]|[】\]]$/g, '').trim()
}

function looksLikeNavTitle(title) {
  return !title || title.length < 6 || NAV_LABEL.test(title) || /^(?:学院简介|部门概况|联系我们|更多)$/.test(title)
}

const CJK_OR_WORD = /[\u4e00-\u9fa5a-zA-Z0-9]/

/** Turn a fetched detail page into a digest item, or null if it is not an article. */
function buildItem({ article, candidate, site, topics, minScore, maxAgeDays = 400, force = false }) {
  const body = String(article.body || '').replace(/\n{2,}/g, '\n').trim()
  const compact = body.replace(/\s/g, '')
  if (compact.length < 120) return null
  if (compact.length < 200 && !/[\u4e00-\u9fa5]{20,}/.test(compact)) return null

  const pageClean = cleanTitle(article.title, site?.name)
  const listClean = cleanLabel(candidate.label)
  // The detail page's <title> is the authoritative title. The list label is the
  // fallback when the page title is only the site name, and it also wins when it
  // is a crisp prefix of a page title that swallowed the first paragraph.
  let title = pageClean && !looksLikeNavTitle(pageClean) ? pageClean : listClean
  if (title && listClean.length >= 8 && title.length > listClean.length + 8 && title.startsWith(listClean)) {
    title = listClean
  }
  if (!title || looksLikeNavTitle(title)) title = listClean
  if (looksLikeNavTitle(title)) return null
  if (title.length > 80) title = `${title.slice(0, 78).replace(/[\s，,。；;、]+$/, '')}…`

  const date = article.date || candidate.date || null
  // A homepage can still link something from two years ago; recency alone must
  // never be the reason an item is interesting, and stale pages are dropped.
  if (!force && date) {
    const ageDays = (Date.now() - new Date(`${date}T00:00:00`).getTime()) / 86400000
    if (ageDays > maxAgeDays) return null
  }

  const scoreText = body.slice(0, 2600)
  const { score, matched } = matchTopics({ title, body: scoreText }, topics)
  if (!force && matched.length === 0) return null
  const boosted = score + recencyBoost(date)
  // Body-only hits are mostly bylines and boilerplate ("…记者 实习生…"); keep a
  // vague title only when the body matches hard.
  const titleHit = matched.some((topic) => topic.titleHits > 0)
  if (!force && !titleHit && boosted < 9) return null
  if (!force && boosted < minScore) return null

  const summary = ruleSummary(title, body)
  const deadline = extractDeadline(body)
  const contact = extractContact(body)

  return {
    id: normalizeUrl(article.url || candidate.url),
    url: article.url || candidate.url,
    title,
    body: body.slice(0, 4000),
    summary,
    date,
    deadline,
    contact,
    source: site?.id || 'custom',
    sourceName: site?.name || '',
    score: boosted,
    matched,
    titleKey: titleKey(title),
    firstSeen: new Date().toISOString(),
    read: false,
    summaryEngine: 'rule',
  }
}

function hostOfUrl(url) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function siteFor(config, url) {
  const host = hostOfUrl(url)
  if (!host) return null
  const family = registrableLoose(host)
  // Same host first: news.cau.edu.cn and www.cau.edu.cn are different sources and
  // labelling a news page with the notice-board name would be wrong.
  const sites = config.sites || []
  const exact = sites.find((site) => hostOfUrl(site.url) === host)
  if (exact) return exact
  return sites.find((site) => registrableLoose(hostOfUrl(site.url)) === family) || null
}

/**
 * One full refresh pass over every enabled source.
 * @returns {Promise<{added: number, errors: string[], elapsedMs: number}>}
 */
async function refresh({ config, store, log = () => {} }) {
  const startedAt = Date.now()
  const topics = effectiveTopics(config)
  const sites = (config.sites || []).filter((site) => site.enabled !== false && /^https?:\/\//i.test(site.url))
  const errors = []
  let added = 0
  let budget = Number(config.maxDetailFetches) || 36
  const limit = Number(config.maxItemsPerSource) || 8

  for (let siteIndex = 0; siteIndex < sites.length; siteIndex++) {
    if (budget <= 0) break
    const site = sites[siteIndex]
    // Fair share of the remaining detail-fetch budget, so one talkative homepage
    // cannot starve the later sources. Extra allowance covers pages that get
    // rejected (galleries, sections, duplicates).
    const remainingSites = sites.length - siteIndex
    const share = Math.max(4, Math.floor(budget / remainingSites))
    let siteBudget = Math.min(share, Math.max(limit + 4, Math.ceil(limit * 1.6)))

    log(`读取 ${site.name}`)
    try {
      const list = await fetchText(site.url, { timeoutMs: 20000 })
      if (!list.ok) {
        errors.push(`${site.name} 列表页 HTTP ${list.status}`)
        continue
      }
      const candidates = pickCandidates(list.text, list.url || site.url, site)
      log(`${site.name} 找到 ${candidates.length} 个候选`)
      let harvested = 0

      for (const candidate of candidates) {
        if (budget <= 0 || siteBudget <= 0 || harvested >= limit) break
        if (store.has(candidate.url) || store.has(normalizeUrl(candidate.url))) continue
        if (store.hasTitleKey(titleKey(candidate.label))) continue

        siteBudget -= 1
        budget -= 1
        try {
          const detail = await fetchText(candidate.url, { referer: site.url, timeoutMs: 20000 })
          if (!detail.ok) {
            errors.push(`${site.name} 详情 HTTP ${detail.status}`)
            continue
          }
          const article = extractArticle(detail.text, detail.url || candidate.url)
          const item = buildItem({
            article,
            candidate,
            site,
            topics,
            minScore: Number(config.minScore) || 3,
            maxAgeDays: Number(config.maxAgeDays) || 400,
          })
          if (!item) continue
          // The same story is often linked from several sections with different
          // URLs; the title fingerprint is what collapses those into one card.
          if (store.hasTitleKey(item.titleKey)) continue

          if (config.llm?.enabled && config.llm?.apiKey) {
            const better = await llmSummary(item, config.llm)
            if (better) {
              item.summary = better
              item.summaryEngine = 'llm'
            }
          }

          if (store.add(item, { limit: 300 }).added) {
            added += 1
            harvested += 1
            log(`+ ${item.title.slice(0, 30)}`)
          }
        } catch (error) {
          errors.push(`${site.name} 详情失败 ${error.message}`)
        }
      }
    } catch (error) {
      errors.push(`${site.name} 抓取失败 ${error.message}`)
    }
  }

  store.setRun({
    lastRun: new Date().toISOString(),
    lastError: errors.length ? errors.slice(0, 3).join('；') : null,
  })
  store.save()

  return { added, errors, elapsedMs: Date.now() - startedAt }
}

/**
 * Explicitly add one URL the user pasted. Bypasses the score threshold (the user
 * already declared interest) but still goes through the same extraction.
 */
async function addUrl({ url, config, store }) {
  const fetched = await fetchText(url, { timeoutMs: 20000 })
  if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`)
  const article = extractArticle(fetched.text, fetched.url || url)
  const site = siteFor(config, fetched.url || url) || { id: 'pasted', name: '手动添加' }
  const topics = effectiveTopics(config)
  const item = buildItem({
    article,
    candidate: { url: fetched.url || url, label: pageTitle(fetched.text), date: article.date },
    site,
    topics,
    minScore: 0,
    force: true,
  })
  if (!item) throw new Error('这个页面没找到正文（可能是纯图片页或需要登录）')

  if (config.llm?.enabled && config.llm?.apiKey) {
    const better = await llmSummary(item, config.llm)
    if (better) {
      item.summary = better
      item.summaryEngine = 'llm'
    }
  }

  item.pinned = true
  store.add(item, { limit: 300 })
  store.save()
  return item
}

module.exports = {
  refresh,
  addUrl,
  pickCandidates,
  buildItem,
  cleanTitle,
  cleanLabel,
  siteFor,
  registrableLoose,
  sameSiteFamily,
}
