'use strict'

// Dependency-free HTML understanding.
//
// There is no cheerio/jsdom here on purpose: the pet ships as a single portable
// exe that must keep working offline and stay small, and every site we read is
// a plain CMS page where regex + text-density heuristics are enough. The two
// things that actually need care are (1) never letting navigation chrome leak
// into an article body and (2) getting the publish date from the page rather
// than guessing it from list markup.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7',
  times: '\u00d7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  ensp: ' ', emsp: ' ', thinsp: ' ', laquo: '\u00ab', raquo: '\u00bb',
  rarr: '\u2192', larr: '\u2190', uarr: '\u2191', darr: '\u2193', bull: '\u2022',
}

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, token) => {
    if (token[0] === '#') {
      const hex = token[1] === 'x' || token[1] === 'X'
      const code = hex ? parseInt(token.slice(2), 16) : parseInt(token.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    const value = ENTITIES[token.toLowerCase()]
    return value === undefined ? match : value
  })
}

const BLOCK_TAGS = 'p|div|br|li|tr|h1|h2|h3|h4|h5|h6|section|article|header|footer|blockquote|td|th|dt|dd|pre|ul|ol|table|tbody|thead|hr|figure|figcaption|nav|aside|main|form|address'
const BLOCK_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi')

/** HTML -> readable text. Block boundaries become newlines so paragraphs survive. */
function htmlToText(html) {
  if (!html) return ''
  let out = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
  out = out.replace(BLOCK_RE, '\n').replace(/<[^>]*>/g, '')
  out = decodeEntities(out).replace(/\u00a0/g, ' ')
  return out
    .replace(/[ \t\f\v\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Inline text only: no block breaks, for link labels and titles. */
function inlineText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/[\s\u00a0]+/g, ' ').trim()
}

function attr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = attrs.match(re)
  if (!match) return ''
  return decodeEntities((match[1] ?? match[2] ?? match[3] ?? '').trim())
}

/** Every anchor on the page, resolved against the page URL, with local context. */
function extractAnchors(html, baseUrl) {
  const anchors = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = re.exec(html))) {
    const attrs = match[1]
    const href = attr(attrs, 'href').trim()
    if (!href || /^(?:javascript:|#|mailto:|tel:|data:)/i.test(href)) continue
    let absolute
    try {
      absolute = new URL(href, baseUrl).href
    } catch {
      continue
    }
    const label = inlineText(match[2])
    const title = inlineText(attr(attrs, 'title'))
    const start = Math.max(0, match.index - 700)
    anchors.push({
      href: absolute,
      label,
      title,
      pos: match.index,
      contextBefore: html.slice(start, match.index),
      contextAfter: html.slice(match.index + match[0].length, match.index + match[0].length + 160),
    })
  }
  return anchors
}

const ARTICLE_CONTAINER_RE =
  /<(div|article|section)\b([^>]*(?:class|id)\s*=\s*["'][^"']*(?:article|content|detail|zoom|TRS_Editor|vsb_content|news_content|post_body|entry|artibody|txt_con|xl_con)[^"']*["'][^>]*)>/gi

const STRONG_CONTAINER = /article|TRS_Editor|vsb_content|zoom|detail|news_content|artibody|txt_con|xl_con/i

/** Cut an element's full markup by walking its own tag depth (regex-only balancing). */
function sliceBalanced(html, start) {
  const head = html.slice(start, start + 40)
  const tagName = (head.match(/^<([a-zA-Z][a-zA-Z0-9]*)/)?.[1] || 'div').toLowerCase()
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi')
  re.lastIndex = start
  let depth = 0
  let match
  while ((match = re.exec(html))) {
    if (match[1] === '/') {
      depth -= 1
      if (depth <= 0) return html.slice(start, match.index + match[0].length)
    } else if (!/\/>\s*$/.test(match[0])) {
      depth += 1
    }
  }
  return html.slice(start, start + 40000)
}

function linkRatio(html) {
  const total = inlineText(html).length
  if (!total) return 1
  let linked = 0
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) linked += inlineText(match[1]).length
  return Math.min(1, linked / total)
}

/** Pull the article body out of a detail page. */
function extractArticle(html, url) {
  const candidates = []
  ARTICLE_CONTAINER_RE.lastIndex = 0
  let match
  while ((match = ARTICLE_CONTAINER_RE.exec(html))) {
    const attrs = match[2] || ''
    const block = sliceBalanced(html, match.index)
    const text = htmlToText(block)
    if (text.length < 60) continue
    const ratio = linkRatio(block)
    let score = text.length * (1 - Math.min(ratio, 0.95))
    if (STRONG_CONTAINER.test(attrs)) score *= 1.9
    if (ratio > 0.45) score *= 0.25
    candidates.push({ text, score, ratio })
  }

  let body = ''
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score)
    body = candidates[0].text
  }

  // Fallback: no recognised container. Drop chrome by tag, then take the longest
  // run of consecutive non-empty lines as the body.
  if (body.replace(/\s/g, '').length < 120) {
    const stripped = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|menu)\b[\s\S]*?<\/\1>/gi, ' ')
    const lines = htmlToText(stripped).split('\n')
    let best = []
    let run = []
    for (const line of lines) {
      if (line.replace(/\s/g, '').length >= 12) {
        run.push(line)
        if (run.join('').length > best.join('').length) best = run.slice()
      } else {
        run = []
      }
    }
    if (best.join('').length > body.replace(/\s/g, '').length) body = best.join('\n')
  }

  return {
    url,
    title: pageTitle(html),
    body: cleanBody(body),
    date: pageDate(html),
    siteName: pageTitle(html).split(/\s*[-–—|_]\s*/).pop()?.trim() || '',
  }
}

/** Remove boilerplate lines that survive density filtering (breadcrumbs, counters). */
function cleanBody(text) {
  const NOISE = /^(?:当前位置|您所在的位置|首页|返回|上一篇|下一篇|打印|关闭|收藏|分享|浏览(?:次数|量)?|访问量|点击量|责任编辑|编辑|来源|作者|发布时间|发布日期|字体|字号|扫一扫|二维码|相关(?:阅读|链接|新闻|文章)|版权所有|备案|Copyright|地址|邮编)/i
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !NOISE.test(line) && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(line))
    .join('\n')
    .trim()
}

function pageTitle(html) {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
  return inlineText(raw)
}

/** Publish date, preferring explicit metadata, then a labelled line, then any date near the top. */
function pageDate(html) {
  const meta = [
    /<meta\b[^>]*name\s*=\s*["'](?:PubDate|publishdate|pubdate|publish_date|date|DC\.date\.issued)["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["'](?:PubDate|publishdate|date)["']/i,
    /<meta\b[^>]*property\s*=\s*["']article:published_time["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  ]
  for (const re of meta) {
    const raw = html.match(re)?.[1]
    const iso = parseDateValue(raw)
    if (iso) return iso
  }

  const text = htmlToText(html).slice(0, 4000)
  const labelled = text.match(/(?:发布日期|发布时间|时间|日期)\s*[:：]\s*((?:20\d{2})[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2})/)
  if (labelled) {
    const iso = parseDateValue(labelled[1])
    if (iso) return iso
  }
  return parseDateValue(text.slice(0, 1200)) || null
}

/** Accepts "2026-10-22 15:14:00", "2026年10月22日", "2026.10.22", "10/15, 2026". */
function parseDateValue(input) {
  if (!input) return null
  const raw = String(input).trim()

  let m = raw.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/)
  if (m) return isoDate(m[1], m[2], m[3])

  m = raw.match(/(\d{1,2})\s*[/.]\s*(\d{1,2})\s*,\s*(20\d{2})/)
  if (m) return isoDate(m[3], m[1], m[2])

  m = raw.match(/^(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*月?$/)
  if (m) return isoDate(m[1], m[2], 1)

  return null
}

function isoDate(year, month, day) {
  const y = Number(year)
  const mo = Number(month)
  const d = Number(day)
  if (!(y >= 2000 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

module.exports = {
  decodeEntities,
  htmlToText,
  inlineText,
  extractAnchors,
  extractArticle,
  pageTitle,
  pageDate,
  parseDateValue,
  cleanBody,
  isoDate,
  attr,
}
