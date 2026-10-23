'use strict'

// Optional LLM upgrade path.
//
// The shipped default is the rule summarizer in filter.js: no key, no cost, no
// network beyond the sources themselves. When the user later drops an API key
// into settings, this module takes over and returns a tighter, genuinely
// synthesized summary. Any failure (no network, bad key, rate limit, gibberish)
// returns null so the caller silently keeps the rule summary — the pet never
// degrades into an empty card because an API was down.

const TIMEOUT_MS = 25000

const SYSTEM_PROMPT = [
  '你是一个把中文校园通知/新闻压缩成摘要的助手。',
  '规则：',
  '1. 用中文输出 1-2 句话，总长不超过 90 字。',
  '2. 只写原文里存在的信息，绝不编造时间、地点、金额、联系人。',
  '3. 优先保留可操作信息：做什么、谁可以参加、截止时间、怎么报名/联系。',
  '4. 不要客套话，不要说“本文介绍”这类废话，不要加标题前缀。',
].join('\n')

function buildUserPrompt(item) {
  const parts = [`标题：${item.title}`, `来源：${item.sourceName || '未知'}`, `日期：${item.date || '未知'}`]
  parts.push(`正文：\n${String(item.body || '').slice(0, 3000)}`)
  return parts.join('\n')
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  if (/\/chat\/completions$/i.test(raw)) return raw
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`
  return `${raw}/v1/chat/completions`
}

/**
 * @returns {Promise<string|null>} summary text, or null to keep the rule summary
 */
async function llmSummary(item, llmConfig) {
  const endpoint = normalizeBaseUrl(llmConfig?.baseUrl)
  if (!endpoint || !llmConfig?.apiKey) return null

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model || 'deepseek-chat',
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(item) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string') return null
    const clean = text.replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”\s]+$/g, '').trim()
    if (clean.length < 10 || clean.length > 220) return null
    return clean
  } catch {
    return null
  }
}

/** Ask the configured endpoint whether the key/model actually work. */
async function testConnection(llmConfig) {
  const endpoint = normalizeBaseUrl(llmConfig?.baseUrl)
  if (!endpoint) return { ok: false, message: '接口地址为空' }
  if (!llmConfig?.apiKey) return { ok: false, message: 'API key 为空' }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${llmConfig.apiKey}` },
      body: JSON.stringify({
        model: llmConfig.model || 'deepseek-chat',
        max_tokens: 16,
        messages: [{ role: 'user', content: '只回复两个字：可用' }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, message: `HTTP ${res.status}${detail ? ` ${detail.slice(0, 120)}` : ''}` }
    }
    const data = await res.json().catch(() => null)
    const text = data?.choices?.[0]?.message?.content
    return { ok: true, message: typeof text === 'string' ? text.trim().slice(0, 40) : '已连通' }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

module.exports = { llmSummary, testConnection, normalizeBaseUrl }
