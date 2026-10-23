#!/usr/bin/env node
'use strict'

// Headless runner: exercises the exact pipeline the pet uses, without launching
// Electron. Useful for tuning keyword sets and for checking that a site still
// parses before shipping.
//
//   node tools/preview-feed.cjs                 # all enabled sites
//   node tools/preview-feed.cjs --fresh         # wipe the preview store first
//   node tools/preview-feed.cjs --url <link>    # add one pasted link
//   node tools/preview-feed.cjs --json          # raw digest as JSON

const path = require('node:path')
const os = require('node:os')

const { createStore } = require('../core/store')
const { refresh, addUrl } = require('../core/pipeline')
const { DEFAULT_CONFIG } = require('../core/config')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

const dir = path.join(os.tmpdir(), 'blob-pet-preview')
const store = createStore(dir)
const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

if (flag('--fresh')) store.clear()

function line(char = '─', width = 78) {
  return char.repeat(width)
}

function printItem(item, index) {
  const topics = (item.matched || []).map((topic) => topic.name).join('/') || '—'
  console.log(`${index + 1}. [${item.score}分] ${topics}  ·  ${item.date || '日期未知'}  ·  ${item.sourceName}`)
  console.log(`   ${item.title}`)
  if (item.summary) console.log(`   摘要: ${item.summary}`)
  if (item.deadline) console.log(`   截止: ${item.deadline}`)
  if (item.contact) console.log(`   联系: ${item.contact}`)
  console.log(`   原文: ${item.url}`)
  console.log('')
}

async function main() {
  const url = value('--url')
  if (url) {
    const item = await addUrl({ url, config, store })
    console.log('已添加单页：')
    printItem(item, 0)
    return
  }

  console.log(`刷新 ${config.sites.filter((site) => site.enabled).length} 个站点 → ${dir}\n`)
  const startedAt = Date.now()
  const result = await refresh({ config, store, log: (message) => console.log(`  · ${message}`) })
  console.log(`\n完成：新增 ${result.added} 条，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  if (result.errors.length) {
    console.log(`\n警告 ${result.errors.length} 条：`)
    for (const error of result.errors.slice(0, 10)) console.log(`  ! ${error}`)
  }

  const items = store.sorted()
  if (flag('--json')) {
    console.log(JSON.stringify(items, null, 2))
    return
  }

  console.log(`\n${line('═')}`)
  console.log(`摘要库共 ${items.length} 条，未读 ${store.unreadCount()}`)
  console.log(line('═'))
  console.log('')
  items.slice(0, 25).forEach(printItem)
}

main().catch((error) => {
  console.error('失败:', error.message)
  process.exitCode = 1
})
