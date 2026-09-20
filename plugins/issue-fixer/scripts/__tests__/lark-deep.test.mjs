import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadConfig } from '../lib/config.mjs'
import { larkResolveUser } from '../lib/lark.mjs'
import { collectLarkEvidence, extractLarkLinks, textFromRecord } from '../lib/evidence.mjs'
import { deliverFixNotification } from '../lib/notify.mjs'
import { getTracker } from '../lib/tracker.mjs'
import { scratchFields } from '../lib/tracker-lark-base.mjs'

// Dispatching lark-cli stub: whoami, contact search, base-create/table-list,
// docs +fetch (markdown stdout), and a catch-all ok envelope. Logs every argv.
const makeStub = (dir) => {
  const bin = join(dir, 'lark-cli-stub')
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LARK_LOG"
case "$1 $2" in
  "whoami ")
    printf '%s' '{"available":true,"identity":"user","onBehalfOf":{"openId":"ou_operator","userName":"Op"}}' ;;
  "contact +search-user")
    printf '%s' '{"ok":true,"data":{"users":[{"open_id":"ou_found","name":"Alice","p2p_chat_id":"oc_p2p"}]}}' ;;
  "base +base-create")
    printf '%s' '{"ok":true,"data":{"app":{"app_token":"bas_scratch"}}}' ;;
  "base +table-list")
    printf '%s' '{"ok":true,"data":{"items":[{"name":"Issues","table_id":"tbl_scratch"}]}}' ;;
  "docs +fetch")
    printf '%s' '# fetched doc content' ;;
  *)
    printf '%s' '{"ok":true,"data":{"message_id":"om_1"}}' ;;
esac
`)
  chmodSync(bin, 0o755)
  return bin
}

const withStub = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-lark-deep-'))
  const prev = { bin: process.env.LARK_CLI_BIN, log: process.env.FAKE_LARK_LOG }
  process.env.LARK_CLI_BIN = makeStub(dir)
  process.env.FAKE_LARK_LOG = join(dir, 'calls.log')
  writeFileSync(process.env.FAKE_LARK_LOG, '')
  t.after(() => {
    process.env.LARK_CLI_BIN = prev.bin
    process.env.FAKE_LARK_LOG = prev.log
    rmSync(dir, { recursive: true, force: true })
  })
  await fn({ dir, log: process.env.FAKE_LARK_LOG })
}

test('extractLarkLinks classifies docx/wiki/minutes/message links', () => {
  const links = extractLarkLinks(
    'see https://t.feishu.cn/docx/AbC123 and https://t.larkoffice.com/wiki/Wk9 also om_x7f3 ' +
    'and https://t.feishu.cn/minutes/Mn55 plus https://t.feishu.cn/sheets/Sh1 and https://t.feishu.cn/docx/AbC123',
  )
  const byKind = Object.fromEntries(links.map((l) => [l.kind, l.token]))
  assert.equal(byKind.docx, 'AbC123')
  assert.equal(byKind.wiki, 'Wk9')
  assert.equal(byKind.minutes, 'Mn55')
  assert.equal(byKind.sheets, 'Sh1')
  assert.equal(byKind.message, 'om_x7f3')
  assert.equal(links.filter((l) => l.token === 'AbC123').length, 1) // deduped
})

test('extractLarkLinks ignores non-lark urls', () => {
  assert.deepEqual(extractLarkLinks('https://github.com/a/b/issues/1 no lark'), [])
})

test('textFromRecord walks nested record fields', () => {
  const rec = { fields: { 问题描述: [{ text: 'see https://t.feishu.cn/docx/D1' }], 其他: 5 } }
  assert.match(textFromRecord(rec), /docx\/D1/)
})

test('collectLarkEvidence fetches docx links and marks sheets manual', withStub(async ({ dir }) => {
  const out = join(dir, 'ev')
  const manifest = await collectLarkEvidence(
    'doc https://t.feishu.cn/docx/DOC1 sheet https://t.feishu.cn/sheets/SH1',
    out,
  )
  const doc = manifest.find((m) => m.kind === 'docx')
  assert.equal(doc.status, 'fetched')
  assert.match(readFileSync(doc.file, 'utf8'), /fetched doc content/)
  assert.equal(manifest.find((m) => m.kind === 'sheets').status, 'manual')
}))

test('collectLarkEvidence batches om_ message ids through mget', withStub(async ({ dir, log }) => {
  const manifest = await collectLarkEvidence('check om_aaa and om_bbb', join(dir, 'ev'))
  assert.equal(manifest.every((m) => m.status === 'fetched'), true)
  assert.match(readFileSync(log, 'utf8'), /messages-mget --message-ids om_aaa,om_bbb --download-resources/)
}))

test('scratchFields maps the semantic field map to base field JSON', () => {
  const cfg = loadConfig({ repoDir: '/tmp/repo' })
  const fields = scratchFields(cfg.tracker.fields, cfg.tracker.status)
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]))
  assert.equal(byName['问题描述'], 'text')
  assert.equal(byName['状态'], 'select')
  assert.equal(byName['提出人'], 'user')
  assert.equal(byName['问题截图'], 'attachment')
  const status = fields.find((f) => f.name === '状态')
  assert.deepEqual(status.options.map((o) => o.name), ['待修复', '修复中', '待验收', '已修复'])
})

test('initScratch creates a base and resolves the table id', withStub(async ({ log }) => {
  const tracker = getTracker(loadConfig({ repoDir: '/tmp/repo', tracker: { type: 'lark-base' } }))
  const res = await tracker.initScratch()
  assert.equal(res.baseToken, 'bas_scratch')
  assert.equal(res.tableId, 'tbl_scratch')
  assert.equal(res.configSnippet.tracker.scratch.baseToken, 'bas_scratch')
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /base-create --name issue-fixer scratch --table-name Issues --fields/)
  assert.match(calls, /table-list --base-token bas_scratch/)
}))

test('larkResolveUser resolves a name via contact search', withStub(async ({ log }) => {
  const hit = await larkResolveUser('Alice')
  assert.equal(hit.ok, true)
  assert.equal(hit.openId, 'ou_found')
  assert.match(readFileSync(log, 'utf8'), /contact \+search-user --as user --format json --query Alice/)
}))

test('notify.type=lark sends to chatId when configured', withStub(async ({ log }) => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', notify: { type: 'lark', chatId: 'oc_group' } })
  await deliverFixNotification({ title: 't', target: 'scratch' }, { cfg, backend: 'local' })
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /--chat-id oc_group/)
  assert.doesNotMatch(calls, /--user-id/)
}))

test('notify.type=lark resolves a name openId via contact before DMing', withStub(async ({ log }) => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', notify: { type: 'lark', openId: 'Alice' } })
  await deliverFixNotification({ title: 't', target: 'scratch' }, { cfg, backend: 'local' })
  const calls = readFileSync(log, 'utf8')
  assert.match(calls, /contact \+search-user/)
  assert.match(calls, /--user-id ou_found/)
}))
