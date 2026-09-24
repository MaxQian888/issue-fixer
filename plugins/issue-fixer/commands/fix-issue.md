---
description: 修复一条 tracker 记录或直接证据问题，走完 issue-orchestrator 端到端流水线与批准门禁。
argument-hint: "[recordId 或直接证据描述]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task, AskUserQuestion
---

驱动 **issue-orchestrator** skill，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

- 参数是 tracker 记录 ID / URL → `tracker-record` 模式：经 tracker 适配器取记录、
  认领、下载截图，末端可回写记录。
- 参数是问题描述/报错/截图路径等直接证据 → `direct-evidence` 模式：不查 tracker，
  走 report-only，不回写不通知提出人。
- 无参数时先问用户要修什么。
- 已有运行状态时重新校验输入，从第一个未完成步骤恢复；绝不重复已完成的认领、
  MR/PR、报告、回写或通知。

严格执行三道门禁：① 方案确认（指纹、规模档、复现、根因、结局、方案）→ ② 用户测试 +
推送/Draft MR（推送只在批准之后）→ ③ tracker 回写 + 通知（仅 tracker-record）。
不要停在代码、适用证据、E2E 覆盖分析、MR/PR 或 CI 任何一处——完成判定要求每个适用
步骤都是 `done` 或 `not-applicable`。规模档（S/M/L/XL）只调每步深度、不删步骤；无需改码的
结论（已修复、无法复现、符合设计、重复、外部根因、待决策）以调查报告收尾。运行状态、指纹、
回退与进度块一律经 `scripts/lib/runstate.mjs` CLI。

Gate ② 前把受影响用户路径交给独立 `e2e-check` 插件做 composed 检查：持久化
`issue-fixer-e2e/v1` 结果到 `<runDir>/e2e-result.json`，MR 与报告复用前用
`result.mjs read` 校验 issueId + 问题指纹 + 当前仓库 `diffHash` + 回执 SHA-256。
过期交接只重跑 E2E 阶段。Gate ② 收集用户手动测试结果（`passed` / 失败证据 /
具体环境 blocker / 显式 deferred）。

主流程默认不发现、不部署、不验证真实环境；交付后可邀请用户回复一个环境 lane 做一张
真实页面截图。任何一步 blocked/not-applicable 都如实标注，不静默降级。
