import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { STEP_ORDER, STEPS } from '../lib/runstate.mjs'

const readPluginFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('orchestrator completes the primary flow with simulated evidence instead of blocking on env access', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')

  assert.match(skill, /CI 跟进|CI follow-up/)
  assert.match(skill, /完整的失败 job 日志|complete failed job log/)
  assert.match(skill, /重跑[\s\S]*终态|rerun's terminal result/i)
  assert.match(skill, /模拟 Before\/After|simulated Before\/After/i)
  assert.match(skill, /不得阻塞[\s\S]*主流程完成|must not block primary completion/i)
  assert.match(skill, /完成审计|Completion audit/)
  assert.match(skill, /已发布报告|published report/)
  assert.match(skill, /已批准的回写|approved writeback/)
})

test('orchestrator consumes the separate E2E plugin before the existing MR gate', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')

  assert.match(skill, /独立的 `e2e-check` 插件|separate `e2e-check` plugin/i)
  assert.match(skill, /编辑前记录对比点 SHA|record the comparison-point SHA before editing/i)
  assert.match(skill, /调(用)? ?\*\*e2e-check\*\*|invoke \*\*e2e-check\*\*/i)
  assert.match(skill, /显式 defer[\s\S]*手动测试|explicitly defer\s+manual testing/i)
  assert.match(skill, /重做验证、E2E、复核、提交和[\s\S]*本门禁|repeat verification, E2E, review, commit, and this gate/i)
  assert.match(skill, /e2eCheck:/)
  assert.match(skill, /result: passed \| failed \| blocked \| deferred \| pending/)
  assert.match(skill, /e2e-result\.json/)
  assert.match(skill, /result\.mjs read/)
  assert.match(skill, /--issue-id <issueId>/)
  assert.match(skill, /fingerprint[\s\S]*diffHash/i)
  assert.match(skill, /resultPath: string/)
  assert.match(skill, /sha256: string/)
  assert.match(skill, /issueId: string/)

  const e2eIndex = Math.max(skill.indexOf('E2E 覆盖检查'), skill.indexOf('E2E coverage check'))
  const gateIndex = skill.indexOf('GATE ②')
  assert.ok(e2eIndex >= 0 && gateIndex > e2eIndex)
})

test('non-UI issues complete with behavior evidence instead of mandatory screenshot fields', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')

  assert.match(skill, /classification=ui.*(可见界面|visible surface)/is)
  assert.match(skill, /(非 ?UI|non-UI)[\s\S]*(行为验证说明|behavior verification note)/i)
  assert.match(skill, /UI\/可见界面问题[\s\S]*确认目标路由能加载|For UI\/visible-surface issues, confirm the target route loads/i)
  assert.match(skill, /定向行为检查 \+ 适用的路由加载|targeted behavior check \+ applicable route load/i)
  assert.match(skill, /适用的附件|applicable attachments/i)
  assert.match(skill, /productEntryUrl: string \| not-applicable/)
  assert.match(skill, /simulated:.*not-applicable/s)
})

test('capture contract defaults to a deterministic simulated component and preserves matching states', async () => {
  const skill = await readPluginFile('skills/before-after-capture/SKILL.md')

  assert.match(skill, /(默认模式|default mode)[\s\S]*simulated-component/i)
  assert.match(skill, /不做认证探测|do not run an authentication probe/i)
  assert.match(skill, /(每张 PNG|each PNG)[\s\S]*SIMULATED/i)
  assert.match(skill, /before-default/)
  assert.match(skill, /before-hover/)
  assert.match(skill, /after-default/)
  assert.match(skill, /after-hover/)
})

test('real-env capture is an explicit follow-up with one confirmed lane and fixed routing headers', async () => {
  const captureSkill = await readPluginFile('skills/before-after-capture/SKILL.md')
  const orchestrator = await readPluginFile('skills/issue-orchestrator/SKILL.md')

  assert.match(orchestrator, /回复一个环境 lane|reply with an? env lane|reply with the env lane/i)
  assert.match(orchestrator, /真实环境在主流程中[\s\S]*`skipped`|real-env is always `skipped` throughout the primary flow/i)
  assert.match(orchestrator, /不跑\s+`deploy\.mjs find` 或 `deploy\.mjs deploy`|do not run\s+`deploy\.mjs find` or `deploy\.mjs deploy`/i)
  assert.match(captureSkill, /real-env/)
  assert.match(captureSkill, /x-preview.*1/i)
  assert.match(captureSkill, /x-env.*(已确认 lane|confirmed lane)/i)
  assert.match(captureSkill, /一次导航|one navigation/i)
  assert.match(captureSkill, /不要试替代域名、header 或 lane 名|do not try alternate\s+domains, headers, or lane names/i)
  assert.match(captureSkill, /real\.png/)
  assert.match(captureSkill, /simulated-component.*(输出|output)/i)
  assert.match(captureSkill, /real-env.*(输出|output)/i)
  assert.doesNotMatch(captureSkill, /deploy\.mjs find|deploy\.mjs deploy/i)
  assert.doesNotMatch(captureSkill, /machine-token|storageState|isolated browser/i)

  const completionIndex = Math.max(orchestrator.indexOf('完成审计'), orchestrator.indexOf('Completion audit'))
  const envFollowUpIndex = Math.max(
    orchestrator.indexOf('可选真实环境后续'),
    orchestrator.indexOf('Optional real-env follow-up'),
  )
  assert.ok(completionIndex >= 0 && envFollowUpIndex > completionIndex)
})

test('frontend verification has a fast local-dev lane between simulation and real env', async () => {
  const captureSkill = await readPluginFile('skills/before-after-capture/SKILL.md')
  const orchestrator = await readPluginFile('skills/issue-orchestrator/SKILL.md')
  const localize = await readPluginFile('skills/ui-issue-localize/SKILL.md')

  assert.match(captureSkill, /local-dev/)
  assert.match(captureSkill, /常驻.*dev server|one persistent dev server/i)
  assert.match(captureSkill, /devServerCommand/)
  assert.match(captureSkill, /remote backend|远程后端/)
  assert.match(captureSkill, /按迭代重启|restart per iteration/i)
  assert.match(captureSkill, /live local dev \+ remote backend/)
  assert.match(orchestrator, /截基线[\s\S]*`before` 产物|capture the\s+baseline `before` artifact now/i)
  assert.match(orchestrator, /保持温热|warm across the fix → verify → capture loop/i)
  assert.match(localize, /local-dev/)
})

test('captured images are rendered in the conversation body instead of replaced by placeholders or cards', async () => {
  const captureSkill = await readPluginFile('skills/before-after-capture/SKILL.md')
  const orchestrator = await readPluginFile('skills/issue-orchestrator/SKILL.md')

  assert.match(captureSkill, /conversationMarkdown/)
  assert.match(captureSkill, /绝对本地路径|absolute local paths/i)
  assert.match(captureSkill, /Markdown 图片表格|Markdown image table/i)
  assert.match(captureSkill, /\| 状态 \| Before · 修复前 \| After · 修复后 \|/)
  assert.match(captureSkill, /\| 默认态 \| !\[before default\]\(\/absolute\/run\/before-default\.png\)/)
  assert.match(captureSkill, /\| 悬浮态 \| !\[before hover\]\(\/absolute\/run\/before-hover\.png\)/)
  assert.match(orchestrator, /`conversationMarkdown`[\s\S]*渲染|渲染[\s\S]*`conversationMarkdown`|render the returned `conversationMarkdown`/i)
  assert.match(orchestrator, /states: \[\{ name: string, beforePath: string, afterPath: string, action: string \}\]/)
  assert.match(orchestrator, /conversationMarkdown: string/)
})

test('slash command resumes direct evidence and does not stop at an intermediate artifact', async () => {
  const command = await readPluginFile('commands/fix-issue.md')

  assert.match(command, /从第一个未完成步骤恢复|resume at the first incomplete step/i)
  assert.match(command, /direct-evidence/)
  assert.match(command, /不要停在代码、适用证据、E2E 覆盖分析、MR\/PR 或 CI 任何一处|Do not stop after code, applicable evidence, E2E coverage analysis, MR, or CI alone/i)
  assert.match(command, /受影响用户路径|affected user paths/)
  assert.match(command, /手动测试结果|manual-test result/i)
  assert.match(command, /composed/)
  assert.match(command, /issue-fixer-e2e\/v1/)
  assert.match(command, /e2e-result\.json/)
  assert.match(command, /当前仓库 `diffHash`|current repository `diffHash`/)
  assert.match(command, /回执 SHA-256|receipt SHA-256/)
  assert.match(command, /只重跑 E2E 阶段|rerun only the E2E stage/i)
  assert.match(command, /回复一个环境 lane|reply with an? env lane/i)
  assert.match(command, /默认不发现、不部署、不验证真实环境|do not discover,[\s\S]*deploy, or validate real env by default/i)
})

test('session context advertises simulated evidence first and optional real-env follow-up', async () => {
  const hook = await readPluginFile('hooks/session-start.mjs')

  assert.match(hook, /模拟 before\/after|simulated before\/after/i)
  assert.match(hook, /回复一个环境 lane|reply with an? env lane/i)
  assert.match(hook, /不得阻塞完成|must not block completion/i)
  assert.match(hook, /e2e-check 插件分析真实 diff|e2e-check plugin analyzes the actual diff/i)
  assert.match(hook, /路径一明确就发手测清单|manual checklist as soon as paths are known/i)
  assert.match(hook, /issue-fixer-e2e\/v1/)
  assert.match(hook, /e2e-result\.json/)
  assert.match(hook, /当前[\s\S]*diffHash|current diffHash/)
  assert.match(hook, /产物 SHA-256|artifact SHA-256/)
  assert.match(hook, /只重跑 E2E|rerun only E2E/i)
})

test('orchestrator step table is the runstate canonical step list, in order', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')
  const rows = [...skill.matchAll(/^\| (\d+) \| `([a-z0-9]+)` \| ([^|]+) \|/gm)]
  assert.deepEqual(rows.map((row) => row[2]), STEP_ORDER)
  assert.deepEqual(rows.map((row) => row[3].trim()), STEPS.map((step) => step.label))
  // every canonical step has its own section with a completion criterion
  for (const [index, id] of STEP_ORDER.entries()) {
    const heading = new RegExp(`^### ${index + 1}\\. [^\\n]*${id.startsWith('gate') ? 'GATE' : `\`${id}\``}`, 'm')
    assert.match(skill, heading, `missing section for ${id}`)
  }
  const sections = skill.split(/^### \d+\. /m).slice(1)
  assert.equal(sections.length, STEP_ORDER.length)
  for (const section of sections) assert.match(section, /\*\*完成判据\*\*/, section.split('\n')[0])
})

test('orchestrator scales depth by tier without dropping steps and ends on an explicit outcome', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')
  assert.match(skill, /档只决定做多深，从不决定哪步不做/)
  assert.match(skill, /步骤不适用只有四种来源/)
  assert.match(skill, /reopen <step>/)
  assert.match(skill, /S 档照样走完\s*每个适用步骤/)
  for (const outcome of ['already-fixed', 'cannot-reproduce', 'not-a-bug', 'duplicate', 'needs-decision', 'external', 'escalated', 'split']) {
    assert.match(skill, new RegExp(outcome))
  }
  assert.match(skill, /调查报告/)
  assert.match(skill, /熔断/)
  assert.match(skill, /升档即回 Gate ①/)
})

test('orchestrator requires root cause, red before fix, independent review, and push only after gate ②', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')
  assert.match(skill, /因果链（触发 → 代码路径 → 错误状态 → 症状）/)
  assert.match(skill, /fixKind=mitigation/)
  assert.match(skill, /先红灯再修/)
  assert.match(skill, /\*\*bugfix-review\*\*/)
  assert.match(skill, /本步只提交，\*\*不推送\*\*/)
  assert.match(skill, /推送只发生在 gate ② 批准\s*之后/)
  assert.match(skill, /基线新鲜度/)

  const at = (needle) => skill.indexOf(needle)
  assert.ok(at('### 8. `red`') < at('### 9. `fix`'))
  assert.ok(at('### 13. `review`') < at('### 15. 🚦 GATE ②'))
  assert.ok(at('### 15. 🚦 GATE ②') < at('`git push -u origin HEAD`（在 worktree 内）'))
})

test('orchestrator references exist and are each reached by a pointer', async () => {
  const skill = await readPluginFile('skills/issue-orchestrator/SKILL.md')
  for (const ref of ['sizing', 'outcomes', 'diagnosis', 'gates', 'situations', 'failures']) {
    assert.ok(existsSync(new URL(`../../skills/issue-orchestrator/references/${ref}.md`, import.meta.url)), ref)
    assert.match(skill, new RegExp(`\\(references/${ref}\\.md\\)`), `${ref}.md is not linked`)
  }
  const sizing = await readPluginFile('skills/issue-orchestrator/references/sizing.md')
  assert.match(sizing, /判档表——取命中的最高档/)
  assert.match(sizing, /熔断预算/)
  const gates = await readPluginFile('skills/issue-orchestrator/references/gates.md')
  for (const gate of ['## Gate ① · 方案', '## Gate ② · 手测 + 推送/MR', '## Gate ③ · 回写 + 通知']) assert.ok(gates.includes(gate), gate)
})
