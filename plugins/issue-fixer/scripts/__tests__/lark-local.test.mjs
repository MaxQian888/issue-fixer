import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadConfig } from '../lib/config.mjs'
import { larkWhoami } from '../lib/lark.mjs'
import { getTracker } from '../lib/tracker.mjs'
import { deliverFixNotification } from '../lib/notify.mjs'

// A stub lark-cli: answers `whoami`, records every other call's argv, returns an ok envelope.
const makeStub = (dir) => {
  const bin = join(dir, 'lark-cli-stub')
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = "whoami" ]; then
  printf '%s' '{"available":true,"identity":"user","onBehalfOf":{"openId":"ou_operator","userName":"Op"}}'
  exit 0
fi
printf '%s' "$*" > "$FAKE_LARK_LOG"
printf '%s' '{"ok":true,"data":{"message_id":"om_1"}}'
`)
  chmodSync(bin, 0o755)
  return bin
}

const withStub = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-lark-'))
  const prev = { bin: process.env.LARK_CLI_BIN, log: process.env.FAKE_LARK_LOG }
  process.env.LARK_CLI_BIN = makeStub(dir)
  process.env.FAKE_LARK_LOG = join(dir, 'calls.log')
  t.after(() => {
    process.env.LARK_CLI_BIN = prev.bin
    process.env.FAKE_LARK_LOG = prev.log
    rmSync(dir, { recursive: true, force: true })
  })
  await fn({ dir, log: process.env.FAKE_LARK_LOG })
}

test('larkWhoami reports operator identity and availability', withStub(async () => {
  const me = await larkWhoami()
  assert.equal(me.ok, true)
  assert.equal(me.identity, 'user')
  assert.equal(me.openId, 'ou_operator')
  assert.equal(me.userName, 'Op')
}))

test('larkWhoami surfaces a missing binary instead of throwing', async () => {
  const prev = process.env.LARK_CLI_BIN
  process.env.LARK_CLI_BIN = '/nonexistent/lark-cli'
  try {
    const me = await larkWhoami()
    assert.equal(me.ok, false)
    assert.equal(me.kind, 'missing_bin')
    assert.match(me.reason, /lark-cli not found/)
  } finally {
    process.env.LARK_CLI_BIN = prev
  }
})

test('tracker preflight reports missing table config', withStub(async () => {
  const tracker = getTracker(loadConfig({
    repoDir: '/tmp/repo',
    tracker: { type: 'lark-base' },
  }))
  const pf = await tracker.preflight()
  assert.equal(pf.ok, false)
  assert.equal(pf.kind, 'config')
  assert.deepEqual(pf.missing, ['tracker.baseToken', 'tracker.tableId'])
}))

test('tracker preflight reports the operator when lark-cli is ready', withStub(async () => {
  const tracker = getTracker(loadConfig({
    repoDir: '/tmp/repo',
    tracker: { type: 'lark-base', baseToken: 'tok', tableId: 'tbl' },
  }))
  const pf = await tracker.preflight()
  assert.equal(pf.ok, true)
  assert.equal(pf.kind, 'ready')
  assert.equal(pf.operator.openId, 'ou_operator')
}))

test('reporterOf normalizes user cells and plain strings', () => {
  const tracker = getTracker(loadConfig({
    repoDir: '/tmp/repo',
    tracker: { type: 'lark-base', baseToken: 'tok', tableId: 'tbl' },
  }))
  assert.deepEqual(
    tracker.reporterOf({ fields: { 提出人: [{ id: 'ou_rep', name: ' Reporter ' }] } }),
    { openId: 'ou_rep', name: ' Reporter ' },
  )
  assert.deepEqual(tracker.reporterOf({ fields: { 提出人: '张三' } }), { openId: '', name: '张三' })
  assert.deepEqual(tracker.reporterOf({ fields: {} }), { openId: '', name: '' })
})

test('notify.type=lark resolves the DM target via whoami when openId is unset', withStub(async ({ log }) => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', notify: { type: 'lark' } })
  const res = await deliverFixNotification(
    { title: 'fixed', issueDesc: 'x', target: 'scratch' },
    { cfg, backend: 'local' },
  )
  assert.equal(res.ok, true)
  const call = readFileSync(log, 'utf8')
  assert.match(call, /--user-id ou_operator/)
  assert.match(call, /--msg-type interactive/)
}))

test('notify.type=lark prefers an explicit notifyOpenId over whoami', withStub(async ({ log }) => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', notify: { type: 'lark', openId: 'ou_explicit' } })
  await deliverFixNotification({ title: 't', target: 'scratch' }, { cfg, backend: 'local' })
  assert.match(readFileSync(log, 'utf8'), /--user-id ou_explicit/)
}))
