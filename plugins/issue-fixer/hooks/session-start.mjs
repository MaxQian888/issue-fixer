#!/usr/bin/env node
// SessionStart hook: inject issue-fixer context so the agent knows the configured tracker,
// target repo, scratch-guard, and how to trigger a fix. Pure/side-effect-free and fast.
import { getConfig } from '../scripts/lib/config.mjs'

let cfg
try {
  cfg = getConfig()
} catch {
  cfg = null
}

const tracker = cfg?.tracker?.type || 'none'
const repo = cfg?.repoDir || '(FIXER_REPO_DIR 未配置)'
const base = cfg?.baseBranch || 'main'
const target = cfg?.target || 'scratch'

const context = `# issue-fixer 已启用
目标仓库：${repo}。tracker=${tracker}，forge=${cfg?.forge?.type || 'git'}，notify=${cfg?.notify?.type || 'stdout'}，report=${cfg?.report?.type || 'markdown'}。
用 /fix-issue <selector> 触发 tracker 记录修复，或直接发问题描述 + 截图/报错/复现。
直接给出可用证据时走 issue-orchestrator 的 direct-evidence 模式，跳过全部 tracker
查记录/认领/下载/回写步骤；绝不因为缺 record id 就反问。
模式 FIXER_TARGET=${target}。scratch 模式下绝不动真实 tracker、绝不私信真实提出人。
流程（tracker-record）：读记录→定位→🚦→worktree 修复→验证→证据→E2E 审计/补→🚦 用户测试+MR→CI→报告→🚦 回写。
流程（direct-evidence）：所供证据→定位→🚦→worktree 修复→验证→证据→E2E 审计/补→🚦 用户测试+MR→CI→报告。
编辑都在隔离 worktree（{repoParent}/{repoName}-fix-<issueId>，起自刚 fetch 的
origin/${base}）；主 checkout 保持不动。非流水线输入委派：工单→workitem-quick-fix，
未验证论断→claim-verify-first，探索打样→prototype，其他→input-dispatch。
独立的 e2e-check 插件分析真实 diff、推导受影响用户路径、检查断言级覆盖，并用归属的
仓库 E2E harness 补齐/跑通缺失覆盖。路径一明确就发手测清单，测试可与后续并行；
Gate ② 核对结果，用户可在批准 MR 时显式 deferred 手测。
composed 模式下以 schema issue-fixer-e2e/v1 原子持久化 <runDir>/e2e-result.json。
复用、Gate ②、MR 或报告之前，用 E2E 插件的 scripts/result.mjs 校验其消费者问题指纹、
当前 diffHash 与产物 SHA-256。blocked 结果恢复续跑；问题指纹或仓库 diff 过期时只重跑 E2E。
绝不用内联 E2E 摘要顶替已校验产物。
UI/可见修复用模拟 before/after；趁 worktree 还在 $BASE（编辑前）先截基线。fixture 表达不了
状态时走 local-dev 通道——worktree 上一个常驻 dev server 连远程后端，比部署环境快、无 SSO 墙。
非 UI 修复用行为验证说明。
真实环境截图为完成后的可选项：邀请用户回复一个环境 lane，然后用配置的 env 头模板
（capture.envHeaders）在真实入口截同一状态。真实采集不得阻塞完成。
forge=github 时经 gh 建 Draft PR：owner/name 自动从 origin remote 解析（无需 forge.repo），
同 head 的开放 PR 去重并更新标题/正文；CI 跟进用 mr.mjs checks（gh pr checks 分桶）。
前置条件：gh 在 PATH 且已 gh auth login。forge=git 只推分支并如实报 deployPending。
从第一个未完成的主步骤恢复；绝不重启已完成工作，默认不做真实环境探索。`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }),
)
