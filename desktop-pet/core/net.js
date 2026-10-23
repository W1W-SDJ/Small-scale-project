'use strict'

// Fetching layer: every network byte the pet consumes comes through here.
//
// Two things matter on Chinese university sites and are easy to get wrong:
//  * Charset. Several CAU hosts still serve GBK while declaring nothing useful
//    in the header, so the meta tag has to be consulted before decoding.
//  * Politeness. These are small department servers; hammering them in parallel
//    gets you an empty page or a ban. Requests to one host are serialised with a
//    minimum gap and a hard timeout.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MIN_GAP_MS = 900
const lastHitAt = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

/** Declared charset from the HTTP header, else from the <meta> tags. */
function detectCharset(buffer, contentType) {
  let cs = (contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]
  if (!cs) {
    const head = buffer.subarray(0, 4096).toString('latin1')
    cs =
      head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] ||
      head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i)?.[1]
  }
  return (cs || 'utf-8').toLowerCase()
}

function decodeBuffer(buffer, charset) {
  // 'gb2312'/'gbk' labels are covered by the gb18030 decoder in Node's ICU, so a
  // broken or missing declaration still lands on a readable page.
  for (const label of [charset, 'utf-8', 'gb18030']) {
    if (!label) continue
    try {
      return new TextDecoder(label).decode(buffer)
    } catch {
      /* unknown label: fall through to the next candidate */
    }
  }
  return buffer.toString('utf8')
}

async function waitForHost(url) {
  let host
  try {
    host = new URL(url).host
  } catch {
    return
  }
  const last = lastHitAt.get(host) || 0
  const wait = last + MIN_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastHitAt.set(host, Date.now())
}

/**
 * Fetch a URL as text with charset correction.
 * @returns {Promise<{ok: boolean, status: number, url: string, text: string, charset: string, bytes: number}>}
 */
async function fetchText(url, options = {}) {
  const { timeoutMs = 20000, retries = 1, headers = {}, referer } = options
  let lastError = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForHost(url)
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(referer ? { referer } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const buffer = Buffer.from(await res.arrayBuffer())
      const charset = detectCharset(buffer, res.headers.get('content-type'))
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        text: decodeBuffer(buffer, charset),
        charset,
        bytes: buffer.length,
      }
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1200)
    }
  }
  throw new Error(`${describeError(lastError)} (${url})`)
}

function describeError(error) {
  if (!error) return 'unknown fetch error'
  if (error.name === 'TimeoutError') return '请求超时'
  if (error.name === 'AbortError') return '请求中止'
  const cause = error.cause
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') return '域名解析失败'
  if (cause?.code === 'ECONNREFUSED') return '连接被拒绝'
  if (cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
  if (cause?.code === 'CERT_HAS_EXPIRED') return '证书已过期'
  return `${error.name}: ${error.message}${cause?.code ? ` (${cause.code})` : ''}`
}

module.exports = { fetchText, detectCharset, decodeBuffer, sleep, describeError, UA }
