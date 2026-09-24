import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { progressMarker } from '../progress.mjs'
import { buildReportMarkdown } from '../report.mjs'
import {
  STEP_ORDER,
  firstUnfinished,
  gateDecisionFor,
  gateDecisionId,
  initRunState,
  issueFingerprint,
  listRuns,
  loadRunState,
  notApplicableSteps,
  progressSteps,
  recordGateDecision,
  reopen,
  resumePoint,
  setMeta,
  setStep,
} from '../lib/runstate.mjs'

const RUNSTATE_CLI = fileURLToPath(new URL('../lib/runstate.mjs', import.meta.url))
const tempRun = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [RUNSTATE_CLI, ...args], { encoding: 'utf8' }))
const cliFails = (...args) => spawnSync(process.execPath, [RUNSTATE_CLI, ...args], { encoding: 'utf8' })
const doneThrough = (dir, last) => {
  for (const id of STEP_ORDER.slice(0, STEP_ORDER.indexOf(last) + 1)) {
    if (!['gate1', 'gate2', 'gate3'].includes(id)) setStep(dir, id, { status: 'done' })
  }
}

test('canonical step order puts reproduction before localization and review before the MR gate', () => {
  const at = (id) => STEP_ORDER.indexOf(id)
  assert.ok(at('triage') < at('reproduce') && at('reproduce') < at('locate') && at('locate') < at('gate1'))
  assert.ok(at('baseline') < at('red') && at('red') < at('fix'))
  assert.ok(at('e2e') < at('review') && at('review') < at('commit') && at('commit') < at('gate2'))
  // push + Draft MR only after gate ② approval
  assert.ok(at('gate2') < at('publish') && at('publish') < at('ci'))
  assert.ok(at('report') < at('gate3') && at('gate3') < at('writeback') && at('writeback') < at('audit'))
})

test('rule-based applicability comes from mode and outcome, never from tier', () => {
  assert.deepEqual(notApplicableSteps({ mode: 'tracker-record' }), {})
  assert.equal(notApplicableSteps({ mode: 'direct-evidence' }).gate3, 'mode:direct-evidence')
  assert.equal(notApplicableSteps({ mode: 'direct-evidence' }).writeback, 'mode:direct-evidence')

  const alreadyFixed = notApplicableSteps({ mode: 'tracker-record', outcome: 'already-fixed' })
  for (const id of ['worktree', 'red', 'fix', 'e2e', 'gate2', 'publish', 'ci']) {
    assert.equal(alreadyFixed[id], 'outcome:already-fixed', id)
  }
  // the investigation is still reported and (tracker) written back after gate ③
  assert.equal(alreadyFixed.report, undefined)
  assert.equal(alreadyFixed.gate3, undefined)

  // a split parent publishes its split note; an abandoned run publishes nothing
  // but still reaches gate ③ so a claimed record can be released
  assert.equal(notApplicableSteps({ mode: 'direct-evidence', outcome: 'split' }).report, undefined)
  const abandoned = notApplicableSteps({ mode: 'tracker-record', outcome: 'abandoned' })
  assert.equal(abandoned.report, 'outcome:abandoned')
  assert.equal(abandoned.writeback, undefined)
})

test('outcome proposals re-derive applicability before gate ① without touching done steps', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-1', mode: 'direct-evidence', tier: 'S' })
  doneThrough(dir, 'reproduce')

  setMeta(dir, { outcome: 'cannot-reproduce', reason: '按描述 3 种视口均未复现' })
  let state = loadRunState(dir)
  assert.equal(state.steps.fix.status, 'not-applicable')
  assert.equal(firstUnfinished(state), 'locate')

  setMeta(dir, { outcome: 'fixed', reason: '补充账号后复现' })
  state = loadRunState(dir)
  assert.equal(state.steps.fix.status, 'pending')
  assert.equal(state.steps.reproduce.status, 'done')
  assert.equal(state.steps.gate3.status, 'not-applicable')
  assert.deepEqual(state.outcomeHistory.map((h) => h.outcome), ['cannot-reproduce', 'fixed'])
})

test('after gate ① the tier and outcome only change through a reopen', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-2', mode: 'tracker-record', tier: 'S', tierReason: '单文件文案' })
  doneThrough(dir, 'locate')
  setMeta(dir, { tier: 'M', reason: '共享组件 4 个调用方', outcome: 'fixed' })
  setMeta(dir, { tier: 'S', reason: '重新评估：只有 1 个调用方' }) // proposals may move freely before gate ①
  recordGateDecision(dir, 'r-2', 'gate1', 'approved', { step: 'gate1' })

  assert.throws(() => setMeta(dir, { tier: 'M', reason: '方案外文件' }), /reopen <runDir> gate1/)
  assert.throws(() => setMeta(dir, { outcome: 'already-fixed', reason: 'x' }), /reopen <runDir> locate/)
  setMeta(dir, { tier: 'S', fixKind: 'root-cause' }) // unchanged tier is fine

  reopen(dir, 'gate1', '改码中发现要动第二个包')
  setMeta(dir, { tier: 'L', reason: '跨 2 个包' })
  const state = loadRunState(dir)
  assert.deepEqual(state.tierHistory.map((h) => h.tier), ['S', 'M', 'S', 'L'])
  assert.throws(() => setMeta(dir, { tier: 'XXL' }), /invalid tier/)
})

test('reopen rewinds every later step, keeps artifacts, and starts a new gate round', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-5', mode: 'tracker-record' })
  doneThrough(dir, 'locate')
  setMeta(dir, { outcome: 'cannot-reproduce', reason: '三种环境均正常' })
  recordGateDecision(dir, 'r-5', 'gate1', 'approved', { step: 'gate1' })
  setStep(dir, 'report', { status: 'done', artifacts: { reportUrl: '/abs/report.md' } })
  recordGateDecision(dir, 'r-5', 'gate3', 'approved', { step: 'gate3' })
  setStep(dir, 'writeback', { status: 'done' })
  setStep(dir, 'audit', { status: 'done' })
  assert.equal(resumePoint(loadRunState(dir)).status, 'complete')
  const oldGate1Id = gateDecisionId('r-5', 'gate1')

  // the reporter supplies the missing account → reproducible after all
  reopen(dir, 'locate', '提出人补充了管理员账号，已复现')
  let state = loadRunState(dir)
  for (const id of ['locate', 'gate1', 'report', 'gate3', 'writeback', 'audit']) {
    assert.equal(state.steps[id].status, 'pending', id)
  }
  assert.equal(state.steps.report.artifacts.reportUrl, '/abs/report.md') // update in place, never a second doc
  assert.equal(state.steps.fix.status, 'not-applicable') // still excluded until the outcome changes
  assert.deepEqual(resumePoint(state), { step: 'locate', label: '定位', status: 'pending', reopenedBecause: '提出人补充了管理员账号，已复现' })

  // the old gate ① answer no longer counts — a late HIL submit for it is ignored
  assert.equal(gateDecisionFor(state, 'r-5', 'gate1'), null)
  assert.equal(state.gates.gate1.round, 2)
  assert.notEqual(gateDecisionId('r-5', 'gate1', 2), oldGate1Id)

  setMeta(dir, { outcome: 'fixed', reason: '已复现，根因在权限判断' })
  state = loadRunState(dir)
  assert.equal(state.steps.fix.status, 'pending')
  assert.throws(() => reopen(dir, 'deploy', 'x'), /unknown step/)
  assert.throws(() => reopen(dir, 'fix'), /needs a reason/)
})

test('gate answers apply their effects in the same write', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-3', mode: 'direct-evidence' })
  doneThrough(dir, 'locate')
  setMeta(dir, { outcome: 'fixed', reason: '已定位' })

  // gate ①: changes-requested rewinds to locate and re-asks in a new round
  recordGateDecision(dir, 'r-3', 'gate1', 'changes-requested', { step: 'gate1', summary: '改成只调整移动端断点' })
  let state = loadRunState(dir)
  assert.equal(state.steps.gate1.status, 'pending')
  assert.equal(state.steps.gate1.reopened.previousDecision, 'changes-requested')
  assert.equal(resumePoint(state).step, 'locate')
  assert.equal(resumePoint(state).reopenedBecause, '改成只调整移动端断点')

  setStep(dir, 'locate', { status: 'done' })
  recordGateDecision(dir, 'r-3', 'gate1', 'approved', { step: 'gate1' })
  doneThrough(dir, 'commit')

  // gate ②: a failed manual test rewinds to fix and records the result
  recordGateDecision(dir, 'r-3', 'gate2', 'failed', { step: 'gate2', summary: '第 2 步点击导出仍无反应' })
  state = loadRunState(dir)
  assert.equal(resumePoint(state).step, 'fix')
  assert.equal(state.manualTest.result, 'failed')
  assert.equal(state.gates.gate2.round, 2)

  // gate ②: keep-local closes the gate and excludes publish + ci — resume never pushes
  doneThrough(dir, 'commit')
  recordGateDecision(dir, 'r-3', 'gate2', 'keep-local', { step: 'gate2', summary: '先留在本地' })
  state = loadRunState(dir)
  assert.equal(state.steps.gate2.status, 'done')
  assert.equal(state.steps.publish.status, 'not-applicable')
  assert.equal(state.steps.ci.status, 'not-applicable')
  assert.equal(resumePoint(state).step, 'report')
  assert.equal(progressSteps(state).find((s) => s.label === '推送+MR').note, '先留在本地')

  // unknown answers are refused instead of silently closing or blocking
  assert.throws(() => recordGateDecision(dir, 'r-3', 'gate2', 'yes', { step: 'gate2' }), /invalid gate2 decision "yes"/)
  // a re-answer never keeps a stale summary
  recordGateDecision(dir, 'r-3', 'gate3', 'changes-requested', { step: 'gate3', summary: '备注写短一点' })
  recordGateDecision(dir, 'r-3', 'gate3', 'declined', { step: 'gate3' })
  state = loadRunState(dir)
  assert.equal(state.steps.gate3.summary, undefined)
  assert.equal(state.steps.gate3.waitingFor, undefined)
  assert.equal(state.steps.writeback.status, 'not-applicable')
})

test('gate ① abandon ends the run but keeps gate ③ to release a tracker claim', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-6', mode: 'tracker-record' })
  doneThrough(dir, 'locate')
  recordGateDecision(dir, 'r-6', 'gate1', 'abandon', { step: 'gate1', summary: '需求已取消' })
  const state = loadRunState(dir)
  assert.equal(state.outcome, 'abandoned')
  assert.equal(state.steps.worktree.status, 'not-applicable')
  assert.equal(state.steps.report.status, 'not-applicable')
  assert.equal(resumePoint(state).step, 'gate3')
})

test('progress block derives from run-state in canonical order with the bridge vocabulary', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'r-4', mode: 'direct-evidence' })
  setStep(dir, 'intake', { status: 'done' })
  setStep(dir, 'triage', { status: 'failed' })
  const steps = progressSteps(loadRunState(dir))
  assert.equal(steps.length, STEP_ORDER.length)
  assert.deepEqual(steps[0], { label: '取证', status: 'done' })
  assert.equal(steps[1].status, 'error')
  assert.equal(steps.find((s) => s.label === '🚦回写').status, 'skipped')

  // a hand-written block using run-state statuses no longer degrades to pending
  const block = progressMarker(['报告:not-applicable', '验证:failed'])
  assert.match(block, /"status":"skipped"/)
  assert.match(block, /"status":"error"/)
})

test('fingerprint ignores row positions and whitespace but binds evidence content', (t) => {
  const dir = tempRun(t)
  const shot = join(dir, 'shot.png')
  writeFileSync(shot, 'pixels-a')
  const a = issueFingerprint({ source: 'direct-evidence', description: 'Banner  太高', evidence: [shot] })
  const b = issueFingerprint({ source: 'direct-evidence', description: 'Banner 太高 ', evidence: [shot] })
  assert.equal(a.fingerprint, b.fingerprint)
  assert.match(a.fingerprint, /^fp:[0-9a-f]{16}$/)
  writeFileSync(shot, 'pixels-b')
  const c = issueFingerprint({ source: 'direct-evidence', description: 'Banner 太高', evidence: [shot] })
  assert.notEqual(a.fingerprint, c.fingerprint)
  assert.throws(() => issueFingerprint({ source: 'direct-evidence', description: '  ' }), /verbatim issue description/)
  assert.throws(() => issueFingerprint({ source: 'tracker-record', description: 'x' }), /record id/)
  const p1 = issueFingerprint({ source: 'tracker-record', recordId: 'rec1', description: 'x', priority: 'P1' })
  const p2 = issueFingerprint({ source: 'tracker-record', recordId: 'rec1', description: 'x', priority: 'P0' })
  assert.notEqual(p1.fingerprint, p2.fingerprint)
})

test('runstate CLI drives init → set → gate → resume without ad-hoc scripts', (t) => {
  const dir = tempRun(t)
  const init = cli('init', dir, '--run-id', 'cli-1', '--mode', 'direct-evidence', '--tier', 'M', '--reason', '两个调用方')
  assert.equal(init.resume.step, 'intake')
  assert.equal(init.tier, 'M')
  assert.match(cliFails('init', dir, '--run-id', 'cli-1', '--mode', 'tracker-record').stderr, /resume it/)

  cli('set', dir, 'intake', 'done', '--artifact', 'evidence=/abs/evidence-manifest.json')
  assert.match(cliFails('set', dir, 'triage', 'blocked').stderr, /--waiting-for/)
  assert.match(cliFails('set', dir, 'ci', 'not-applicable').stderr, /--note/)
  assert.match(cliFails('set', dir, 'triage', 'done', '--artifact').stderr, /needs a value/)
  assert.match(cliFails('set', dir, 'triage', 'done', '--artifact', 'novalue').stderr, /key=value/)

  cli('set', dir, 'triage', 'blocked', '--waiting-for', '请提供复现账号的角色')
  assert.deepEqual(cli('resume', dir), { step: 'triage', label: '分诊定档', status: 'blocked', waitingFor: '请提供复现账号的角色' })
  // a value may start with -- (e.g. quoting a command)
  cli('set', dir, 'triage', 'running', '--note', '--force-with-lease 之后重跑')
  assert.equal(cli('resume', dir).note, '--force-with-lease 之后重跑')

  assert.match(cliFails('set', dir, 'deploy', 'done').stderr, /unknown step/)
  assert.match(cliFails('meta', dir, '--outcome', 'duplicate').stderr, /--reason/)
  assert.match(cliFails('gate', dir, 'gate2', 'ok').stderr, /invalid gate2 decision/)

  const gateId = cli('gate-id', dir, 'gate1')
  assert.equal(gateId.round, 1)
  assert.equal(gateId.requestId, gateDecisionId('cli-1', 'gate1'))
  assert.deepEqual(gateId.options, ['approved', 'changes-requested', 'need-info', 'abandon'])

  const shown = cli('show', dir)
  assert.equal(shown.steps.find((s) => s.id === 'intake').artifacts.evidence, '/abs/evidence-manifest.json')

  const progress = execFileSync(process.execPath, [RUNSTATE_CLI, 'progress', dir], { encoding: 'utf8' })
  assert.match(progress, /^```fixer:progress/)
  assert.match(progress, /修复 cli-1 · M/)

  const runs = listRuns(dirname(dir))
  assert.ok(runs.some((run) => run.runDir === dir && run.runId === 'cli-1' && run.resume.step === 'triage'))
})

test('script CLIs run from paths with spaces and through symlinks', (t) => {
  const root = tempRun(t)
  const spaced = join(root, 'Application Support', 'issue fixer')
  mkdirSync(spaced, { recursive: true })
  cpSync(fileURLToPath(new URL('..', import.meta.url)), join(spaced, 'scripts'), { recursive: true })
  const runDir = join(root, 'run')
  const spacedCli = join(spaced, 'scripts', 'lib', 'runstate.mjs')
  const out = JSON.parse(execFileSync(process.execPath, [spacedCli, 'init', runDir, '--run-id', 'sp', '--mode', 'direct-evidence'], { encoding: 'utf8' }))
  assert.equal(out.runId, 'sp')

  const link = join(root, 'linked-runstate.mjs')
  symlinkSync(spacedCli, link)
  const resumed = JSON.parse(execFileSync(process.execPath, [link, 'resume', runDir], { encoding: 'utf8' }))
  assert.equal(resumed.step, 'intake')
})

test('no-change outcomes publish an investigation report with their own proof', () => {
  const base = {
    source: 'direct-evidence',
    issueId: 'export-csv',
    issueDesc: '导出 CSV 缺少表头',
    tier: 'S',
    classification: 'backend',
    conclusion: '最新 origin/main 已包含表头修复',
    investigation: [{ method: '在 origin/main 上跑导出单测', result: '表头存在' }],
    evidence: ['packages/api/src/export.ts:42 写入表头'],
  }
  assert.throws(() => buildReportMarkdown({ ...base, outcome: 'already-fixed' }), /already-fixed requires fixedBy/)

  const report = buildReportMarkdown({ ...base, outcome: 'already-fixed', fixedBy: 'abc1234 fix(export): write header row' })
  assert.match(report, /^# 调查报告/)
  assert.match(report, /最新基线已修复/)
  assert.match(report, /本次无代码改动/)
  assert.match(report, /abc1234/)
  assert.doesNotMatch(report, /undefined|E2E 交接/)

  assert.throws(
    () => buildReportMarkdown({ ...base, outcome: 'needs-decision', options: ['只改文案'] }),
    /needs-decision requires options/,
  )
  assert.throws(() => buildReportMarkdown({ ...base, outcome: 'external', owner: 'billing-service' }), /handoff/)
  assert.throws(() => buildReportMarkdown({ ...base, outcome: 'split', children: ['only-one'] }), /split requires children/)
  assert.match(buildReportMarkdown({ ...base, outcome: 'split', children: ['a · 顶栏', 'b · 导出'] }), /子问题/)
  assert.throws(() => buildReportMarkdown({ ...base, outcome: 'abandoned' }), /produces no report/)
  assert.throws(() => buildReportMarkdown({ ...base, outcome: 'duplicate', investigation: [], duplicateOf: 'x' }), /investigation/)
  assert.throws(
    () => buildReportMarkdown({ ...base, source: 'tracker-record', outcome: 'duplicate', duplicateOf: 'rec2' }),
    /recordId is required/,
  )
})

test('CLI gate answers are refused when stale, out of order, not applicable, or premature', (t) => {
  const dir = tempRun(t)
  cli('init', dir, '--run-id', 'g-1', '--mode', 'direct-evidence')
  assert.match(cliFails('init', dir, '--run-id', 'other', '--mode', 'direct-evidence').stderr, /belongs to runId=g-1/)
  assert.match(cliFails('set', dir, 'gate2', 'done').stderr, /is a gate/)
  assert.match(cliFails('set', dir, 'fix', 'done', 'extra').stderr, /unexpected argument/)
  assert.match(cliFails('gate', dir, 'gate1', 'approved').stderr, /out of order — the run resumes at intake/)
  assert.match(cliFails('gate', dir, 'gate3', 'approved').stderr, /does not apply/)
  assert.match(cliFails('gate', dir, 'gate1', 'toString').stderr, /invalid gate1 decision/)

  for (const id of ['intake', 'triage', 'reproduce', 'locate']) cli('set', dir, id, 'done')
  assert.match(cliFails('gate', dir, 'gate1', 'approved').stderr, /needs the proposed tier and outcome/)
  cli('meta', dir, '--tier', 'S', '--outcome', 'fixed', '--reason', '单文件')

  const round1 = cli('gate-id', dir, 'gate1').requestId
  cli('gate', dir, 'gate1', 'changes-requested', '--summary', '换一个断点', '--request-id', round1)
  cli('set', dir, 'locate', 'done')
  // the round-1 form is answered late: refused, the question was reopened
  assert.match(cliFails('gate', dir, 'gate1', 'approved', '--request-id', round1).stderr, /stale answer/)
  const round2 = cli('gate-id', dir, 'gate1')
  assert.equal(round2.round, 2)
  assert.equal(cli('gate', dir, 'gate1', 'approved', '--request-id', round2.requestId).resume.step, 'worktree')
})

test('reopen keeps a missing-capability exclusion but re-asks gate-answer exclusions', (t) => {
  const dir = tempRun(t)
  initRunState(dir, { runId: 'm-1', mode: 'direct-evidence' })
  cli('set', dir, 'ci', 'not-applicable', '--note', 'forge=git，仓库无 CI 查询工具')
  doneThrough(dir, 'locate')
  setMeta(dir, { tier: 'S', outcome: 'fixed', reason: 'x' })
  recordGateDecision(dir, 'm-1', 'gate1', 'approved', { step: 'gate1' })
  doneThrough(dir, 'commit')
  recordGateDecision(dir, 'm-1', 'gate2', 'keep-local', { step: 'gate2' })
  reopen(dir, 'fix', '评审意见要求改实现')
  const state = loadRunState(dir)
  assert.equal(state.steps.ci.status, 'not-applicable') // capability still missing
  assert.equal(state.steps.publish.status, 'pending') // gate ② will be asked again
})

test('split notes render each child run', () => {
  const report = buildReportMarkdown({
    source: 'direct-evidence',
    issueId: 'multi',
    issueDesc: '顶栏错位且导出报错',
    outcome: 'split',
    conclusion: '两个症状根因不同',
    investigation: ['顶栏：样式；导出：接口 500'],
    evidence: ['Header.tsx:12', 'export.ts:88'],
    children: [{ issueId: 'multi-header', symptom: '顶栏错位' }, { issueId: 'multi-export', symptom: '导出 500' }],
  })
  assert.match(report, /\*\*子问题\*\*：multi-header · 顶栏错位/)
  assert.match(report, /\*\*子问题\*\*：multi-export · 导出 500/)
})

test('a dev server rooted in another tree is restarted, never reused', async (t) => {
  const { startDevServer, stopDevServer } = await import('../devserver.mjs')
  const runDir = tempRun(t)
  const probe = tempRun(t)
  const fix = tempRun(t)
  const cfg = { capture: { devServerCommand: 'sleep 30', productEntryUrl: 'http://127.0.0.1:9' } }
  t.after(() => stopDevServer(runDir))
  const first = await startDevServer(runDir, { cwd: probe, timeoutMs: 500, cfg })
  assert.equal(first.cwd, probe)
  const again = await startDevServer(runDir, { cwd: probe, timeoutMs: 500, cfg })
  assert.equal(again.reused, true)
  const moved = await startDevServer(runDir, { cwd: fix, timeoutMs: 500, cfg })
  assert.equal(moved.reused, undefined)
  assert.equal(moved.restartedFrom, probe)
  assert.equal(moved.cwd, fix)
  assert.notEqual(moved.pid, first.pid)
})
