import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { derivePrStatus } from '../lib/forge.mjs'
import { buildHilFormMessage } from '../lib/notify.mjs'
import {
  firstUnfinished,
  gateDecisionFor,
  gateDecisionId,
  initRunState,
  loadRunState,
  recordGateDecision,
  setStep,
} from '../lib/runstate.mjs'

const ORDER = ['triage', 'locate', 'gate1', 'fix', 'verify', 'gate2', 'pr', 'ci', 'report', 'gate3', 'writeback']

test('derivePrStatus precedence ladder', () => {
  const pr = (over) => ({ number: 1, state: 'OPEN', draft: false, merged: false, reviewDecision: 'none', mergeable: false, conflict: false, ...over })
  const ci = (over) => ({ ok: true, passing: [], pending: [], failing: [], ...over })
  assert.equal(derivePrStatus({ pr: null }), 'none')
  assert.equal(derivePrStatus({ pr: pr({ merged: true }), ci: ci({ failing: ['x'] }) }), 'merged')
  assert.equal(derivePrStatus({ pr: pr({ state: 'CLOSED' }) }), 'closed')
  assert.equal(derivePrStatus({ pr: pr({ draft: true }), ci: ci({ failing: ['x'] }) }), 'draft')
  assert.equal(derivePrStatus({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }), ci: ci({ failing: ['ci'] }) }), 'ci_failed')
  assert.equal(derivePrStatus({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED', conflict: true }) }), 'changes_requested')
  assert.equal(derivePrStatus({ pr: pr({ conflict: true }), ci: ci({ pending: ['ci'] }) }), 'merge_conflict')
  assert.equal(derivePrStatus({ pr: pr({ mergeable: true }), ci: ci({ pending: ['ci'] }) }), 'ci_pending')
  assert.equal(derivePrStatus({ pr: pr({ mergeable: true, reviewDecision: 'APPROVED' }) }), 'mergeable')
  assert.equal(derivePrStatus({ pr: pr({ reviewDecision: 'APPROVED' }) }), 'approved')
  assert.equal(derivePrStatus({ pr: pr({}) }), 'review_pending')
  assert.equal(derivePrStatus({ pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) }), 'pr_open')
})

test('gateDecisionId is stable per run+gate, distinct across runs', () => {
  assert.equal(gateDecisionId('run-1', 'gate1'), gateDecisionId('run-1', 'gate1'))
  assert.notEqual(gateDecisionId('run-1', 'gate1'), gateDecisionId('run-2', 'gate1'))
  assert.match(gateDecisionId('run-1', 'gate1'), /^gate:[0-9a-f]{16}$/)
})

test('run-state: init, setStep, resume point, gate decision round-trip', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-runstate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const st = initRunState(dir, { runId: 'r-1', mode: 'tracker-record', baseSha: 'abc' })
  assert.equal(st.runId, 'r-1')
  assert.equal(firstUnfinished(st, ORDER), 'triage')

  setStep(dir, 'triage', { status: 'done' })
  setStep(dir, 'locate', { status: 'done' })
  recordGateDecision(dir, 'r-1', 'gate1', 'approved', { step: 'gate1' })
  setStep(dir, 'fix', { status: 'blocked', waitingFor: 'user-test' })

  const loaded = loadRunState(dir)
  assert.equal(firstUnfinished(loaded, ORDER), 'fix') // gate1 done → resume at fix
  const found = gateDecisionFor(loaded, 'r-1', 'gate1')
  assert.equal(found.decision, 'approved')
  // A different run id must NOT find this run's decision — re-entry re-asks.
  assert.equal(gateDecisionFor(loaded, 'r-2', 'gate1'), null)

  // rejected decision parks the step as blocked
  recordGateDecision(dir, 'r-1', 'gate2', 'rejected')
  assert.equal(loadRunState(dir).steps['gate:gate2'].status, 'blocked')
  // and an approved gate step shows done under its ORDER name
  assert.equal(loaded.steps.gate1.status, 'done')
})

test('setStep rejects invalid statuses', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-runstate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => setStep(dir, 'x', { status: 'sorta-done' }), /invalid step status/)
})

test('buildHilFormMessage emits the hil_form_v1 contract with plugin_event_publish submit', () => {
  const msg = buildHilFormMessage({
    requestId: 'gate:abc',
    title: 'Gate ② — 批准 MR',
    question: '手测通过，可以建 PR 吗',
    options: [{ label: '批准', value: 'approved' }, { label: '拒绝', value: 'rejected' }],
  })
  assert.equal(msg.msgType, 'interactive')
  assert.equal(msg.mode, 'hil_form_schema')
  assert.equal(msg.schema.schemaVersion, 'hil_form_v1')
  assert.equal(msg.schema.fields[0].key, 'decision')
  assert.equal(msg.schema.fields[0].options.length, 2)
  assert.equal(msg.submit.type, 'plugin_event_publish')
  assert.equal(msg.submit.pluginName, 'issue-fixer')
  assert.equal(msg.requestId, 'gate:abc')
})

test('buildHilFormMessage requires requestId and options', () => {
  assert.throws(() => buildHilFormMessage({ title: 'x', options: [{ label: 'a', value: 'a' }] }), /requestId/)
  assert.throws(() => buildHilFormMessage({ requestId: 'r', title: 'x', options: [] }), /options/)
})
