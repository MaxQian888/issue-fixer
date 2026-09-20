import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPrompt, detectIssueInputMode } from '../lib/input-detect.mjs'
import { buildReportMarkdown } from '../report.mjs'

const image = { kind: 'image', name: 'issue.png', url: 'https://cdn/issue.png' }

const withE2eHandoff = (model) => {
  const directory = mkdtempSync(join(tmpdir(), 'fixer-report-handoff-'))
  const resultPath = join(directory, 'e2e-result.json')
  const fingerprint = 'issue-fingerprint'
  const diffHash = 'b'.repeat(64)
  const result = {
    schemaVersion: 'issue-fixer-e2e/v1',
    mode: 'composed',
    status: 'completed',
    runId: model.issueId,
    repository: '/repo',
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/test',
    diffHash,
    changedFiles: ['file.ts'],
    paths: model.e2eCheck.paths,
    manualTestPrompt: model.manualTest.prompt,
    decision: model.e2eCheck.decision,
    ledger: model.e2eCheck.ledger,
    changes: {
      specs: model.e2eCheck.changes.specs || [],
      fixtures: model.e2eCheck.changes.fixtures || [],
      config: model.e2eCheck.changes.config || [],
    },
    commands: model.e2eCheck.commands,
    blockers: model.e2eCheck.blockers,
    consumer: { plugin: 'issue-fixer', issueId: model.issueId, fingerprint },
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(resultPath, serialized)
  return {
    directory,
    model: {
      ...model,
      e2eHandoff: {
        resultPath,
        schemaVersion: result.schemaVersion,
        sha256: createHash('sha256').update(serialized).digest('hex'),
        diffHash,
        issueId: model.issueId,
        fingerprint,
      },
    },
  }
}

const buildReportWithHandoff = (model) => {
  const handoff = withE2eHandoff(model)
  try {
    return buildReportMarkdown(handoff.model)
  } finally {
    rmSync(handoff.directory, { recursive: true, force: true })
  }
}

test('routes a problem description with a screenshot to direct-evidence mode', () => {
  assert.equal(detectIssueInputMode('默认 banner 太大了，可以控制下高度', [image]), 'direct-evidence')
  assert.equal(detectIssueInputMode('这个按钮点击后没有反应，帮忙修一下', [image]), 'direct-evidence')
  assert.equal(detectIssueInputMode('The dialog is clipped on the right, please fix it', [image]), 'direct-evidence')
  assert.equal(detectIssueInputMode('把这个按钮的高度调整成 32px', [image]), 'direct-evidence')
})

test('routes structured diagnostic evidence without requiring a screenshot', () => {
  assert.equal(detectIssueInputMode('runId: 741852，页面报错了', []), 'direct-evidence')
  assert.equal(detectIssueInputMode('TypeError: Cannot read properties of undefined\n    at App.tsx:42:3', []), 'direct-evidence')
  assert.equal(detectIssueInputMode('页面报错：Cannot read properties of undefined，请修复', []), 'direct-evidence')
  assert.equal(detectIssueInputMode('1. 打开对话页\n2. 点击发送按钮\n3. 页面白屏', []), 'direct-evidence')
  assert.equal(detectIssueInputMode('这个报错请修复', [{ kind: 'file', name: 'error.log', url: 'https://cdn/error.log' }]), 'direct-evidence')
})

test('does not route ordinary image messages into the fix workflow', () => {
  assert.equal(detectIssueInputMode('这是今天活动的合影', [image]), undefined)
  assert.equal(detectIssueInputMode('帮我总结这张图', [image]), undefined)
  assert.equal(detectIssueInputMode('帮忙优化一下这张宣传图', [image]), undefined)
  assert.equal(detectIssueInputMode('处理一下这张照片的颜色', [image]), undefined)
  assert.equal(detectIssueInputMode('这张活动图应该怎么裁剪', [image]), undefined)
  assert.equal(detectIssueInputMode('帮我回答图片里的数学问题', [image]), undefined)
  assert.equal(detectIssueInputMode('帮我总结这个日志', [{ kind: 'file', name: 'server.log', url: 'https://cdn/server.log' }]), undefined)
  assert.equal(detectIssueInputMode('HTTP 404 是什么意思？', []), undefined)
  assert.equal(detectIssueInputMode('runId: 741852，帮我解释一下发生了什么', []), undefined)
  assert.equal(detectIssueInputMode('这里有问题，帮忙看看', []), undefined)
  assert.equal(detectIssueInputMode('/fix-issue recvozrGLkB4Ix', []), undefined)
  assert.equal(
    detectIssueInputMode('请修复页面报错 https://acme.feishu.cn/base/abc?record=rec12345678', []),
    undefined,
  )
})

test('adds a deterministic direct-evidence routing hint without replacing user text', () => {
  const prompt = buildPrompt('这里的间距不对，调整一下', [image])

  assert.match(prompt, /issue-fixer:direct-evidence/)
  assert.match(prompt, /跳过 tracker 记录获取、认领和附件下载/)
  assert.match(prompt, /这里的间距不对，调整一下/)
})

test('orchestrator documents tracker and direct-evidence input modes', async () => {
  const skill = await readFile(
    new URL('../../skills/issue-orchestrator/SKILL.md', import.meta.url),
    'utf8',
  )
  const reportSkill = await readFile(
    new URL('../../skills/fix-report/SKILL.md', import.meta.url),
    'utf8',
  )

  assert.match(skill, /direct-evidence/)
  assert.match(skill, /(不要调用|do not call)[\s`]*tracker\.mjs/i)
  assert.match(skill, /用户提供的截图|user-supplied screenshot/i)
  assert.match(reportSkill, /report-only/)
  assert.match(reportSkill, /direct-evidence[\s\S]*(不要调用|do not call)[\s\S]*tracker\.mjs/i)
})

test('direct-evidence reports do not invent tracker record metadata', () => {
  const report = buildReportWithHandoff({
    source: 'direct-evidence',
    issueId: 'banner-height',
    issueDesc: 'Banner 太高',
    locateFile: 'packages/web/src/Banner.tsx:42',
    planSummary: '限制 Banner 高度',
    diff: '- height: 240\n+ height: 160',
    verify: 'lint、tsc 与视觉对比通过',
    beforeAfterNote: 'Banner 高度已缩小',
    e2eCheck: {
      decision: 'no-new-e2e',
      paths: [{ id: 'banner', entry: '/', actions: ['查看 Banner'], expected: '高度受控' }],
      ledger: [{ path: 'banner', status: 'covered', evidence: ['visual comparison'] }],
      changes: {},
      commands: [{ command: 'visual comparison', result: 'pass' }],
      blockers: [],
    },
    manualTest: {
      prompt: { steps: ['打开首页查看 Banner'], expected: ['Banner 高度受控'] },
      result: 'deferred',
      evidence: '用户明确暂缓手测',
    },
  })

  assert.match(report, /来源.*用户直接提供/)
  assert.doesNotMatch(report, /\*\*记录\*\*/)
  assert.doesNotMatch(report, /undefined|状态.*待验收|表格记录/)
})

test('reports preserve complete E2E and manual-test evidence', () => {
  const report = buildReportWithHandoff({
    source: 'direct-evidence',
    issueId: 'resume-button',
    issueDesc: '恢复按钮无响应',
    locateFile: 'packages/web/src/ResumeButton.tsx:18',
    planSummary: '恢复按钮重新发送 resume 请求',
    diff: '- disabled\n+ enabled',
    verify: 'lint、tsc 与目标行为通过',
    beforeAfterNote: '恢复按钮可操作',
    e2eCheck: {
      decision: 'update-e2e',
      paths: [{ id: 'resume-task', entry: '/tasks/1', actions: ['点击恢复'], expected: '任务恢复' }],
      ledger: [{ path: 'resume-task', status: 'covered', evidence: ['resume.spec.ts'] }],
      changes: { specs: ['packages/web/e2e/specs/task-detail/resume.spec.ts'] },
      commands: [
        { command: 'pnpm e2e resume.spec.ts', result: 'fail' },
        { command: 'pnpm e2e resume.spec.ts', result: 'pass' },
      ],
      blockers: [],
    },
    manualTest: {
      prompt: { prerequisite: '打开任务详情', steps: ['点击恢复'], expected: ['任务恢复'] },
      result: 'passed',
      evidence: '用户确认恢复成功',
    },
  })

  assert.match(report, /E2E 覆盖/)
  assert.match(report, /update-e2e/)
  assert.match(report, /resume\.spec\.ts/)
  assert.match(report, /点击恢复/)
  assert.match(report, /用户确认恢复成功/)
  assert.match(report, /issue-fixer-e2e\/v1/)
  assert.match(report, /e2e-result\.json/)
})

test('reports reject a tampered or stale E2E handoff', () => {
  const handoff = withE2eHandoff({
    source: 'direct-evidence',
    issueId: 'tamper',
    issueDesc: '篡改检查',
    locateFile: 'x.ts:1',
    planSummary: 'x',
    diff: 'x',
    verify: 'x',
    beforeAfterNote: 'x',
    e2eCheck: {
      decision: 'no-new-e2e',
      paths: [{ id: 'x', entry: '/', actions: ['open'], expected: 'visible' }],
      ledger: [{ path: 'x', status: 'covered', evidence: ['spec'] }],
      changes: {},
      commands: [{ command: 'test', result: 'pass' }],
      blockers: [],
    },
    manualTest: { prompt: { steps: ['open'], expected: ['visible'] }, result: 'passed', evidence: 'ok' },
  })
  try {
    writeFileSync(handoff.model.e2eHandoff.resultPath, `${readFileSync(handoff.model.e2eHandoff.resultPath)} `)
    assert.throws(() => buildReportMarkdown(handoff.model), /sha256 mismatch/)
  } finally {
    rmSync(handoff.directory, { recursive: true, force: true })
  }
})

test('reports reject an E2E receipt bound to another issue', () => {
  const handoff = withE2eHandoff({
    source: 'direct-evidence',
    issueId: 'expected-issue',
    issueDesc: '绑定检查',
    locateFile: 'x.ts:1',
    planSummary: 'x',
    diff: 'x',
    verify: 'x',
    beforeAfterNote: 'x',
    e2eCheck: {
      decision: 'no-new-e2e',
      paths: [{ id: 'x', entry: '/', actions: ['open'], expected: 'visible' }],
      ledger: [{ path: 'x', status: 'covered', evidence: ['spec'] }],
      changes: {},
      commands: [{ command: 'test', result: 'pass' }],
      blockers: [],
    },
    manualTest: { prompt: { steps: ['open'], expected: ['visible'] }, result: 'passed', evidence: 'ok' },
  })
  try {
    handoff.model.e2eHandoff.issueId = 'different-issue'
    assert.throws(() => buildReportMarkdown(handoff.model), /issueId mismatch/)
  } finally {
    rmSync(handoff.directory, { recursive: true, force: true })
  }
})

test('reports reject missing E2E or manual-test evidence', () => {
  assert.throws(
    () => buildReportMarkdown({ source: 'direct-evidence', issueId: 'x', issueDesc: 'x' }),
    /planSummary is required/,
  )
  const invalid = withE2eHandoff({
      source: 'direct-evidence',
      issueId: 'x',
      issueDesc: 'x',
      locateFile: 'x.ts:1',
      planSummary: 'x',
      diff: 'x',
      verify: 'x',
      beforeAfterNote: 'x',
      e2eCheck: { decision: 'anything', paths: [], ledger: [], changes: {}, commands: [], blockers: [] },
      manualTest: { prompt: {}, result: 'deferred' },
  })
  try {
    assert.throws(() => buildReportMarkdown(invalid.model), /decision is invalid/)
  } finally {
    rmSync(invalid.directory, { recursive: true, force: true })
  }
})
