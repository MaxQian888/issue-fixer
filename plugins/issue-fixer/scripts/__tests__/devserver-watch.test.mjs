import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { watchChecks } from '../mr.mjs'
import { devServerStatus, hasPidfiles, stopDevServer, sweepDevServers } from '../devserver.mjs'

test('watchChecks resolves immediately when nothing is pending', async () => {
  const forge = { checks: () => ({ ok: true, total: 2, passing: [1, 2], pending: [], failing: [] }) }
  const { code } = await watchChecks(forge, 'b', '/tmp', { timeoutS: 5, intervalS: 1 })
  assert.equal(code, 0)
})

test('watchChecks exits 1 on failures without pending', async () => {
  const forge = { checks: () => ({ ok: true, total: 1, passing: [], pending: [], failing: ['ci'] }) }
  const { code } = await watchChecks(forge, 'b', '/tmp', { timeoutS: 5, intervalS: 1 })
  assert.equal(code, 1)
})

test('watchChecks polls through pending until pass', async () => {
  let n = 0
  const forge = { checks: () => (++n < 2
    ? { ok: true, total: 1, passing: [], pending: ['ci'], failing: [] }
    : { ok: true, total: 1, passing: ['ci'], pending: [], failing: [] }) }
  const { code, result } = await watchChecks(forge, 'b', '/tmp', { timeoutS: 10, intervalS: 0 })
  assert.equal(code, 0)
  assert.equal(n, 2)
  assert.equal(result.passing.length, 1)
})

test('watchChecks times out with pending still listed', async () => {
  const forge = { checks: () => ({ ok: true, total: 1, passing: [], pending: ['ci'], failing: [] }) }
  const { code, result } = await watchChecks(forge, 'b', '/tmp', { timeoutS: 1, intervalS: 0 })
  assert.equal(code, 2)
  assert.equal(result.timedOut, true)
  assert.equal(result.pending.length, 1)
})

test('devserver sweep kills a recorded live process and removes the pidfile', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-devserver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runDir = join(dir, 'run-1')
  const artifacts = dir
  // A real live process we control.
  const child = spawn('sleep', ['60'], { detached: true })
  child.unref()
  t.after(() => { try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ } })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(runDir)
  writeFileSync(join(runDir, 'dev-server.json'), JSON.stringify({ pid: child.pid, command: 'sleep 60', url: 'http://x' }))

  assert.equal(hasPidfiles(artifacts), true)
  assert.equal(devServerStatus(runDir).running, true)
  const res = sweepDevServers(artifacts)
  assert.equal(res.swept[0].action, 'killed')
  assert.equal(existsSync(join(runDir, 'dev-server.json')), false)
})

test('devserver sweep removes a stale pidfile without signalling', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-devserver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runDir = join(dir, 'run-dead')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(runDir)
  // A pid that certainly isn't ours: record a mismatched command vs a live pid.
  writeFileSync(join(runDir, 'dev-server.json'), JSON.stringify({ pid: 1, command: 'pnpm dev', url: 'http://x' }))
  const res = sweepDevServers(dir)
  // pid 1 (launchd/init) is alive but its args won't match 'pnpm' → stale removal, no signal.
  assert.equal(res.swept[0].action, 'stale-pidfile-removed')
  assert.equal(existsSync(join(runDir, 'dev-server.json')), false)
})

test('stopDevServer reports no_pidfile honestly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-devserver-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(stopDevServer(dir).reason, 'no_pidfile')
  assert.equal(devServerStatus(dir).running, false)
})
