// Build the modification report (markdown) and publish it through the configured
// report adapter (report.type): markdown → copy into the run dir and return the path;
// lark-docx → `lark-cli drive +import --type docx`; custom → report.publishCommand
// template ({file} {name}) that must print a URL.
//
// The before/after images are attached to the tracker record's note field by the
// writeback step (tracker.uploadAttachment); the report links to the record and embeds
// the compare note.
//
// CLI:
//   node report.mjs build <modelJsonFile> <out.md>
//   node report.mjs publish <report.md> "<doc name>"
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getConfig, renderTemplate } from './lib/config.mjs'
import { runLark } from './lib/lark.mjs'

const E2E_RESULT_SCHEMA = 'issue-fixer-e2e/v1'

const validateCoreReportEvidence = (m) => {
  for (const field of ['source', 'issueId', 'issueDesc', 'planSummary', 'diff', 'verify', 'beforeAfterNote']) {
    if (!m[field]) throw new Error(`${field} is required`)
  }
  if (!m.locateFile || !/:\d+$/.test(m.locateFile)) {
    throw new Error('locateFile with a 1-based line number is required')
  }
}

export function hydrateE2eHandoff(m) {
  const handoff = m.e2eHandoff
  if (!handoff || typeof handoff !== 'object') throw new Error('e2eHandoff is required')
  if (!isAbsolute(handoff.resultPath || '')) throw new Error('e2eHandoff.resultPath must be absolute')
  if (handoff.schemaVersion !== E2E_RESULT_SCHEMA) throw new Error('e2eHandoff.schemaVersion is invalid')
  if (!/^[0-9a-f]{64}$/.test(handoff.sha256 || '')) throw new Error('e2eHandoff.sha256 is invalid')
  if (!/^[0-9a-f]{64}$/.test(handoff.diffHash || '')) throw new Error('e2eHandoff.diffHash is invalid')
  if (handoff.issueId !== m.issueId) throw new Error('e2eHandoff.issueId mismatch')
  if (!handoff.fingerprint) throw new Error('e2eHandoff.fingerprint is required')

  let serialized
  let result
  try {
    serialized = readFileSync(handoff.resultPath, 'utf8')
    result = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`cannot read E2E handoff: ${error.message}`)
  }
  const actualSha = createHash('sha256').update(serialized).digest('hex')
  if (actualSha !== handoff.sha256) throw new Error('e2eHandoff sha256 mismatch')
  if (result.schemaVersion !== handoff.schemaVersion) throw new Error('e2eHandoff schemaVersion mismatch')
  if (result.mode !== 'composed' || result.status !== 'completed') {
    throw new Error('E2E handoff must be a completed composed result')
  }
  if (result.diffHash !== handoff.diffHash) throw new Error('e2eHandoff diffHash mismatch')
  if (result.consumer?.plugin !== 'issue-fixer'
    || result.consumer?.issueId !== m.issueId
    || result.consumer?.issueId !== handoff.issueId
    || result.consumer?.fingerprint !== handoff.fingerprint) {
    throw new Error('e2eHandoff consumer binding mismatch')
  }

  return {
    ...m,
    e2eCheck: {
      decision: result.decision,
      paths: result.paths,
      ledger: result.ledger,
      changes: result.changes,
      commands: result.commands,
      blockers: result.blockers,
    },
    manualTest: { ...m.manualTest, prompt: result.manualTestPrompt },
    e2eHandoff: { ...handoff, verified: true },
  }
}

export function validateReportEvidence(m) {
  validateCoreReportEvidence(m)
  if (!m.e2eCheck) throw new Error('e2eCheck is required')
  if (!m.manualTest) throw new Error('manualTest is required')

  for (const field of ['paths', 'ledger', 'commands', 'blockers']) {
    if (!Array.isArray(m.e2eCheck[field])) throw new Error(`e2eCheck.${field} must be an array`)
  }
  if (!['needs-e2e', 'update-e2e', 'no-new-e2e'].includes(m.e2eCheck.decision)) {
    throw new Error('e2eCheck.decision is invalid')
  }
  if (!m.e2eCheck.paths.length) throw new Error('e2eCheck.paths must not be empty')
  if (!m.e2eCheck.ledger.length) throw new Error('e2eCheck.ledger must not be empty')
  for (const path of m.e2eCheck.paths) {
    if (!path.id || !path.entry || !Array.isArray(path.actions) || !path.actions.length || !path.expected) {
      throw new Error('each E2E path requires id, entry, actions, and expected')
    }
  }
  for (const row of m.e2eCheck.ledger) {
    if (!['covered', 'partial', 'missing', 'skipped', 'blocked'].includes(row.status)) {
      throw new Error('E2E ledger status is invalid')
    }
    if (!Array.isArray(row.evidence) || !row.evidence.length) {
      throw new Error('each E2E ledger row requires evidence')
    }
  }
  if (!m.e2eCheck.changes || typeof m.e2eCheck.changes !== 'object') {
    throw new Error('e2eCheck.changes is required')
  }
  if (['needs-e2e', 'update-e2e'].includes(m.e2eCheck.decision)
    && !m.e2eCheck.changes.specs?.length) {
    throw new Error('e2eCheck.changes.specs must include the added or updated E2E')
  }
  if (!m.manualTest.prompt || typeof m.manualTest.prompt !== 'object') {
    throw new Error('manualTest.prompt is required')
  }
  if (!Array.isArray(m.manualTest.prompt.steps) || !m.manualTest.prompt.steps.length) {
    throw new Error('manualTest.prompt.steps must not be empty')
  }
  if (!Array.isArray(m.manualTest.prompt.expected) || !m.manualTest.prompt.expected.length) {
    throw new Error('manualTest.prompt.expected must not be empty')
  }
  if (!['passed', 'deferred'].includes(m.manualTest.result)) {
    throw new Error('manualTest.result must be passed or deferred before publishing')
  }
  if (!m.manualTest.evidence) throw new Error('manualTest.evidence is required')

  const actionableGap = m.e2eCheck.ledger.find(({ status }) => ['partial', 'missing', 'blocked'].includes(status))
  if (actionableGap) throw new Error(`E2E coverage is not complete: ${actionableGap.path || actionableGap.status}`)
  if (m.e2eCheck.blockers.length) throw new Error('E2E blockers must be resolved before publishing')
  const finalCommand = m.e2eCheck.commands.at(-1)
  if (!finalCommand || finalCommand.result !== 'pass') {
    throw new Error(`final E2E command did not pass: ${finalCommand?.command || '-'}`)
  }
}

export function buildReportMarkdown(m) {
  validateCoreReportEvidence(m)
  m = hydrateE2eHandoff(m)
  validateReportEvidence(m)
  const L = []
  const directEvidence = m.source === 'direct-evidence' || m.source === 'direct'
  L.push(`# 修改报告 · ${m.issueDesc || m.recordId || m.issueId}`)
  L.push('')
  if (directEvidence) L.push(`- **来源**：用户直接提供（direct-evidence） · ${m.issueId || '-'}`)
  else L.push(`- **记录**：${m.recordId}${m.recordUrl ? ` ([打开](${m.recordUrl}))` : ''}`)
  L.push(`- **模块 / 优先级**：${m.module || '-'} / ${m.priority || '-'}`)
  if (!directEvidence) {
    L.push(`- **提出人**：${m.reporterName || '-'}　**跟进**：issue-fixer`)
    L.push(`- **状态**：待验收`)
  }
  L.push('')
  L.push('## 1. 问题')
  L.push(m.issueDesc || '')
  L.push('')
  L.push('## 2. 定位')
  L.push(`- **文件**：\`${m.locateFile || '-'}\``)
  if (m.locateDetail) L.push(m.locateDetail)
  L.push('')
  L.push('## 3. 修复方案与改动')
  if (m.planSummary) L.push(m.planSummary)
  if (m.diff) {
    L.push('')
    L.push('```diff')
    L.push(m.diff.trim())
    L.push('```')
  }
  L.push('')
  L.push('## 4. 验证')
  L.push(m.verify || '- lint / typecheck / 目标行为')
  L.push('')
  L.push('## 5. E2E 覆盖与用户手测')
  L.push(`- **E2E 交接**：${m.e2eHandoff.schemaVersion} · \`${m.e2eHandoff.resultPath}\``)
  L.push(`- **交接校验**：sha256 ${m.e2eHandoff.sha256.slice(0, 12)}… · diff ${m.e2eHandoff.diffHash.slice(0, 12)}…`)
  if (m.e2eCheck) {
    L.push(`- **覆盖结论**：${m.e2eCheck.decision || '-'}`)
    for (const path of m.e2eCheck.paths || []) {
      L.push(`- **用户路径 ${path.id || '-'}**：${path.entry || '-'} → ${path.expected || '-'}`)
      for (const action of path.actions || []) L.push(`  - 操作：${action}`)
    }
    for (const row of m.e2eCheck.ledger || []) {
      L.push(`- **覆盖明细 ${row.path || '-'}**：${row.status || '-'}${row.gap ? ` · ${row.gap}` : ''}`)
      for (const evidence of row.evidence || []) L.push(`  - 证据：${evidence}`)
    }
    for (const spec of m.e2eCheck.changes?.specs || []) L.push(`- **E2E 改动**：\`${spec}\``)
    for (const item of m.e2eCheck.commands || []) {
      L.push(`- **E2E 命令 (${item.result || '-'})**：\`${item.command || '-'}\``)
    }
    for (const blocker of m.e2eCheck.blockers || []) {
      L.push(`- **E2E 阻塞**：${blocker.reason || '-'}${blocker.resumeWith ? ` · 恢复方式：${blocker.resumeWith}` : ''}`)
    }
  }
  const prompt = m.manualTest.prompt || {}
  if (prompt.prerequisite) L.push(`- **手测前置**：${prompt.prerequisite}`)
  for (const step of prompt.steps || []) L.push(`  - 步骤：${step}`)
  for (const expected of prompt.expected || []) L.push(`  - 预期：${expected}`)
  for (const evidence of prompt.failureEvidence || []) L.push(`  - 失败证据：${evidence}`)
  L.push(`- **用户手测**：${m.manualTest?.result || 'pending'}${m.manualTest?.evidence ? ` · ${m.manualTest.evidence}` : ''}`)
  L.push('')
  L.push('## 6. before / after')
  L.push(m.beforeAfterNote || (directEvidence
    ? '（截图见本次任务产物 / compare.html）'
    : '（截图见跟踪记录附件 / compare.html）'))
  if (m.compareRef) L.push(`\n> 对比页：${m.compareRef}`)
  L.push('')
  L.push('## 7. 链接')
  if (m.mrUrl) L.push(`- MR：${m.mrUrl}`)
  if (m.envUrl) L.push(`- 环境：${m.envUrl}`)
  if (m.taskUrl) L.push(`- 任务：${m.taskUrl}`)
  L.push('')
  L.push('---')
  L.push('_由 issue-fixer 自动生成_')
  return L.join('\n')
}

export async function publishReport(mdPath, name, { cfg = getConfig() } = {}) {
  switch (cfg.report.type) {
    case 'markdown': {
      const out = join(cfg.artifactsDir || '.', 'reports', `${name.replace(/[\\/:*?"<>|]/g, '-')}.md`)
      copyFileSync(mdPath, out)
      return { url: out, path: out, sink: 'markdown' }
    }
    case 'lark-docx': {
      const env = await runLark(['drive', '+import', '--file', mdPath, '--type', 'docx', '--name', name], { as: cfg.tracker.identity || 'user' })
      return { ...env.data, sink: 'lark-docx' }
    }
    case 'custom': {
      if (!cfg.report.publishCommand) throw new Error('report.type=custom requires report.publishCommand')
      const out = execFileSync('/bin/sh', ['-c', renderTemplate(cfg.report.publishCommand, { file: mdPath, name })], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      return { url: out.trim().split('\n').find((line) => /^https?:\/\//.test(line)) || out.trim(), sink: 'custom' }
    }
    default:
      throw new Error(`unknown report type "${cfg.report.type}" — supported: markdown | lark-docx | custom`)
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, ...a] = process.argv.slice(2)
  const run = async () => {
    if (cmd === 'build') {
      const model = JSON.parse(readFileSync(a[0], 'utf8'))
      writeFileSync(a[1], buildReportMarkdown(model))
      console.log(a[1])
    } else if (cmd === 'publish') {
      console.log(JSON.stringify(await publishReport(a[0], a[1] || 'issue-fixer 修改报告'), null, 2))
    } else {
      console.error('usage: report.mjs build <modelJson> <out.md> | publish <md> <name>')
      process.exit(2)
    }
  }
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
