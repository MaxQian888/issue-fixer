import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCiReport,
  classifyFailureLog,
  dedupePipelineRuns,
  parseCodeowners,
  renderReportMarkdown,
  renderReportSummary,
  resolveCodeowners,
  resolveReportWindow,
  signature,
} from '../lib/ci-report.mjs'
import { collectGithubRuns } from '../ci-report.mjs'

test('resolveReportWindow: daily defaults to yesterday in the given timezone', () => {
  const w = resolveReportWindow({ kind: 'daily', timezone: 'Asia/Shanghai', now: '2025-06-10T20:00:00Z' })
  assert.equal(w.since, '2025-06-10') // 2025-06-11 in Shanghai minus 1 day
  assert.equal(w.until, '2025-06-10')
  assert.equal(w.start, '2025-06-10T00:00:00+08:00')
  assert.equal(w.endExclusive, '2025-06-11T00:00:00+08:00')
})

test('resolveReportWindow: weekly last-week is Monday..Sunday', () => {
  const w = resolveReportWindow({ kind: 'weekly', timezone: 'UTC', now: '2025-06-11T12:00:00Z' }) // Wednesday
  assert.equal(w.since, '2025-06-02')
  assert.equal(w.until, '2025-06-08')
})

test('resolveReportWindow: explicit ranges and paired bounds', () => {
  assert.equal(resolveReportWindow({ kind: 'daily', period: '2025-01-01..2025-01-03' }).since, '2025-01-01')
  assert.throws(() => resolveReportWindow({ kind: 'daily', since: '2025-01-01' }), /together/)
  assert.throws(() => resolveReportWindow({ kind: 'monthly' }), /daily or weekly/)
})

test('dedupePipelineRuns keeps first occurrence per id, sorted numerically', () => {
  const runs = dedupePipelineRuns([
    { runId: '10', status: 'failed' },
    { runId: '2', status: 'failed' },
    { runId: '10', status: 'succeeded', extra: true },
  ])
  assert.deepEqual(runs.map(r => r.runId), ['2', '10'])
  assert.equal(runs[1].status, 'failed')
})

test('signature redacts secrets before persisting', () => {
  const log = 'setup ok\nError: request failed token=abc123secret authorization: Bearer xyz789\nmore'
  const sig = signature(log)
  assert.ok(!sig.includes('abc123secret'))
  assert.ok(!sig.includes('xyz789'))
  assert.ok(sig.includes('[REDACTED]'))
})

test('classifyFailureLog: stable features, repo frames only', () => {
  const out = classifyFailureLog(
    'Error: expect(locator).toBeVisible failed\n  at src/pages/Home.tsx:42:10\n  at node_modules/x/y.ts:1:1',
    'e2e',
  )
  assert.equal(out.category, 'locator-visibility')
  assert.deepEqual(out.frames, ['src/pages/Home.tsx:42:10'])
})

test('classifyFailureLog: no-log / e2e-unclassified / typecheck', () => {
  assert.equal(classifyFailureLog('').category, 'no-log')
  assert.equal(classifyFailureLog('playwright ran and something failed', 'e2e').category, 'e2e-unclassified')
  assert.equal(classifyFailureLog('cannot find name Foo\nTS2304', 'build').category, 'typecheck')
})

const ownerRules = parseCodeowners(`
# comment
* @root-owner
src/ @src-team
src/pages/ @pages-owner @pages-backup
*.ts @ts-owner
`)

test('CODEOWNERS: parses pattern → owners, last match wins', () => {
  assert.deepEqual(resolveCodeowners('src/pages/Home.tsx:42:10', ownerRules), ['@pages-owner', '@pages-backup'])
  assert.deepEqual(resolveCodeowners('lib/util.py', ownerRules), ['@root-owner'])
})

const reportInput = {
  kind: 'daily',
  repository: 'o/r',
  window: resolveReportWindow({ kind: 'daily', period: '2025-06-10', timezone: 'UTC' }),
  coverage: { runsEnumerated: 3, logsCollected: 1, warnings: [{ source: 'run-list', message: 'truncated' }] },
  runs: [
    { runId: '1', pipeline: 'ci', status: 'success', durationMs: 60_000, triggerer: 'alice' },
    { runId: '2', pipeline: 'ci', status: 'failure', durationMs: 90_000, triggerer: 'bob',
      mr: { id: 7, author: 'carol' },
      failure: { job: 'test', step: 'vitest', category: 'unit-test-failure', errorSignature: 'tests failed', frames: ['src/a.ts:1'], codeOwners: ['@team'], evidenceLevel: 'signature' } },
    { runId: '3', pipeline: 'e2e', status: 'failure', durationMs: 120_000, triggerer: 'bob',
      failure: { job: 'e2e', step: 'pw', category: 'other', errorSignature: '', frames: [], codeOwners: [], evidenceLevel: 'metadata' } },
  ],
}
const report = buildCiReport(reportInput)

test('buildCiReport: counts statuses, clusters failures, three candidate roles', () => {
  assert.deepEqual(report.statusCounts, { total: 3, succeeded: 1, failed: 2, running: 0, canceled: 0, unknown: 0 })
  assert.equal(report.failureClusters.length, 2)
  const unit = report.failureClusters.find(c => c.category === 'unit-test-failure')
  assert.deepEqual(unit.ownerCandidates.map(o => o.identity), ['carol', '@team', 'bob'])
  assert.deepEqual(unit.ownerCandidates.map(o => o.role), ['change-follow-up', 'code-routing', 'operator'])
})

test('buildCiReport: coverage warnings preserved, metadata-only flagged as gap', () => {
  assert.equal(report.coverageWarnings[0].message, 'truncated')
  const other = report.failureClusters.find(c => c.category === 'other')
  assert.ok(report.evidenceGaps.map(g => g.clusterKey).includes(other.key))
})

test('renderReportMarkdown: window, metrics, warnings, no-blame note', () => {
  const md = renderReportMarkdown(report)
  assert.ok(md.includes('CI 日报'))
  assert.ok(md.includes('truncated'))
  assert.ok(md.includes('不构成事故责任认定'))
  assert.ok(renderReportSummary(report).includes('执行 3'))
})

const ghImpl = {
  listRuns: () => [
    { databaseId: 11, workflowName: 'ci', status: 'completed', conclusion: 'success', createdAt: '2025-06-10T01:00:00Z', startedAt: '2025-06-10T01:00:00Z', updatedAt: '2025-06-10T01:01:00Z', headBranch: 'dev', url: 'u1' },
    { databaseId: 12, workflowName: 'ci', status: 'completed', conclusion: 'failure', createdAt: '2025-06-10T02:00:00Z', startedAt: '2025-06-10T02:00:00Z', updatedAt: '2025-06-10T02:02:00Z', headBranch: 'dev', url: 'u2' },
    { databaseId: 13, workflowName: 'ci', status: 'completed', conclusion: 'success', createdAt: '2025-06-09T02:00:00Z', startedAt: '2025-06-09T02:00:00Z', updatedAt: '2025-06-09T02:01:00Z', headBranch: 'dev', url: 'u3' }, // out of window
  ],
  detail: () => ({ actor: { login: 'bob' }, pull_requests: [{ number: 7 }] }),
  jobs: () => [{ name: 'test', conclusion: 'failure', steps: [{ name: 'vitest', conclusion: 'failure' }] }],
  prAuthor: () => 'carol',
  failedLog: () => 'Error: 1 test failed\n  at src/a.ts:5:3',
}
const window = resolveReportWindow({ kind: 'daily', period: '2025-06-10', timezone: 'UTC' })

test('collectGithubRuns: filters window, enriches failed runs, raw logs never persist', async () => {
  const { runs, enumerated } = await collectGithubRuns({ repo: 'o/r', window, repoDir: '/nonexistent', ghImpl })
  assert.equal(enumerated, 3)
  assert.deepEqual(runs.map(r => r.runId), ['11', '12'])
  const failed = runs.find(r => r.runId === '12')
  assert.equal(failed.triggerer, 'bob')
  assert.deepEqual(failed.mr, { id: 7, author: 'carol' })
  assert.equal(failed.failure.job, 'test')
  assert.equal(failed.failure.step, 'vitest')
  assert.equal(failed.failure.category, 'unit-test-failure')
  assert.equal(failed.failure.evidenceLevel, 'signature')
  assert.ok(!JSON.stringify(runs).includes('1 test failed\n')) // only the signature survives
})

test('collectGithubRuns: caps failed-detail fetches and records the gap', async () => {
  const many = Array.from({ length: 4 }, (_, i) => ({
    databaseId: i + 1, workflowName: 'ci', status: 'completed', conclusion: 'failure',
    createdAt: '2025-06-10T02:00:00Z', startedAt: '2025-06-10T02:00:00Z', updatedAt: '2025-06-10T02:01:00Z', headBranch: 'dev',
  }))
  const { warnings, runs } = await collectGithubRuns({ repo: 'o/r', window, repoDir: '/x', maxFailed: 2, ghImpl: { ...ghImpl, listRuns: () => many } })
  assert.equal(runs.filter(r => r.failure).length, 2)
  assert.ok(warnings.some(w => w.source === 'failed-detail'))
})
