import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadConfig } from '../lib/config.mjs'
import {
  cogniaApiCall,
  cogniaApiDescribe,
  cogniaBinFor,
  cogniaHostEnabled,
  cogniaHostStatus,
  cogniaSessionIdFor,
} from '../lib/cognia.mjs'
import { progressMarkdown, pushProgress } from '../progress.mjs'

const ENV_KEYS = ['FIXER_HOST', 'FIXER_HOST_BIN', 'FIXER_HOST_SESSION_ID', 'FIXER_COGNIA_BIN', 'FIXER_COGNIA_SESSION_ID', 'COGNIA_SESSION_ID', 'PATH']
const withEnv = (fn) => async (t) => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
  await fn(t)
}

const makeStub = (dir, body = `printf '%s' '{"ok":true}'`) => {
  const bin = join(dir, 'cognia-agent-stub')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, 'calls.log')}"\n${body}\n`)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'calls.log'), '')
  return bin
}

test('cogniaBinFor: explicit host.cogniaBin wins over everything', withEnv(async (t) => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', host: { type: 'cognia', cogniaBin: '/opt/cognia' } })
  assert.deepEqual(cogniaBinFor(cfg), ['/opt/cognia'])
}))

test('cogniaBinFor falls back to <repoDir>/cli/dist/cognia-agent.mjs', withEnv(async (t) => {
  process.env.PATH = '' // deterministically remove any PATH install
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dist = join(dir, 'cli', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'cognia-agent.mjs'), '#!/usr/bin/env node\n')
  const cfg = loadConfig({ repoDir: dir, host: { type: 'cognia' } })
  const bin = cogniaBinFor(cfg)
  assert.equal(bin.length, 2)
  assert.match(bin[1], /cli\/dist\/cognia-agent\.mjs$/)
}))

test('cogniaBinFor returns null when nothing resolves', withEnv(async () => {
  process.env.PATH = ''
  const cfg = loadConfig({ repoDir: '/tmp/definitely-no-dist-here-xyz', host: { type: 'cognia' } })
  assert.equal(cogniaBinFor(cfg), null)
}))

test('cogniaSessionIdFor prefers host.sessionId, then notify.cogniaSessionId', withEnv(async () => {
  const a = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', sessionId: 's-host' }, notify: { cogniaSessionId: 's-notify' } })
  assert.equal(cogniaSessionIdFor(a), 's-host')
  const b = loadConfig({ repoDir: '/tmp/r', notify: { type: 'cognia', cogniaSessionId: 's-notify' } })
  assert.equal(cogniaSessionIdFor(b), 's-notify')
}))

test('cogniaHostEnabled: notify.type=cognia implies the host plane', () => {
  assert.equal(cogniaHostEnabled(loadConfig({ repoDir: '/tmp/r' })), false)
  assert.equal(cogniaHostEnabled(loadConfig({ repoDir: '/tmp/r', notify: { type: 'cognia' } })), true)
  assert.equal(cogniaHostEnabled(loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia' } })), true)
})

test('cogniaApiCall shells `api call <verb>` with args and --json', withEnv(async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = makeStub(dir)
  const cfg = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', cogniaBin: bin, sessionId: 'sess-1' } })
  const res = await cogniaApiCall('connector_send', ['--session-id', 'sess-1', '--segments', '[]'], { cfg })
  assert.equal(res.ok, true)
  const call = readFileSync(join(dir, 'calls.log'), 'utf8')
  assert.match(call, /api call connector_send --session-id sess-1 --segments \[\] --json/)
}))

test('cogniaApiCall surfaces CLI failure with stderr remediation', withEnv(async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = makeStub(dir, 'echo "Error: no Cognia host is configured" >&2; exit 1')
  const cfg = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', cogniaBin: bin } })
  await assert.rejects(() => cogniaApiCall('connector_send', [], { cfg }), /no Cognia host is configured/)
}))

test('cogniaApiDescribe resolves the contract without a host', withEnv(async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = makeStub(dir, `printf '%s' 'command connector_send\\nfields --session-id'`)
  const cfg = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', cogniaBin: bin } })
  const res = await cogniaApiDescribe('connector_send', { cfg })
  assert.equal(res.ok, true)
  assert.match(res.contract, /connector_send/)
}))

test('cogniaApiDescribe reports missing_bin when nothing resolves', withEnv(async () => {
  process.env.PATH = ''
  const cfg = loadConfig({ repoDir: '/tmp/definitely-no-dist-here-xyz', host: { type: 'cognia' } })
  const res = await cogniaApiDescribe('connector_send', { cfg })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'missing_bin')
}))

test('cogniaHostStatus flags no_session when bin resolves but no session bound', withEnv(async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', cogniaBin: makeStub(dir) } })
  const st = await cogniaHostStatus(cfg)
  assert.equal(st.enabled, true)
  assert.equal(st.blocker, 'no_session')
}))

test('progressMarkdown renders glyph checklist', () => {
  const md = progressMarkdown(['取证:done', '定位:running', '回写:pending'], '修复 I-1')
  assert.match(md, /\*\*修复 I-1\*\*/)
  assert.match(md, /✅ 取证/)
  assert.match(md, /🔄 定位/)
  assert.match(md, /⬜ 回写/)
})

test('pushProgress is a silent no-op without progressPush', withEnv(async () => {
  const cfg = loadConfig({ repoDir: '/tmp/r', host: { type: 'cognia', cogniaBin: '/bin/true', sessionId: 's' } })
  assert.equal((await pushProgress(['a:done'], 't', { cfg })).pushed, false)
}))

test('pushProgress posts markdown segments via connector_send when enabled', withEnv(async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-cognia-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = makeStub(dir)
  const cfg = loadConfig({
    repoDir: '/tmp/r',
    progressPush: true,
    host: { type: 'cognia', cogniaBin: bin, sessionId: 'sess-p' },
  })
  const res = await pushProgress(['取证:done'], '修复 I-2', { cfg })
  assert.equal(res.pushed, true)
  const call = readFileSync(join(dir, 'calls.log'), 'utf8')
  assert.match(call, /connector_send --session-id sess-p/)
  assert.match(call, /✅ 取证/)
}))
