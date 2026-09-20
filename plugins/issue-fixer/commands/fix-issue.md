---
description: 修复一条 tracker 记录或直接证据问题，走完 issue-orchestrator 端到端流水线与批准门禁。
argument-hint: [recordId 或直接证据描述]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task, AskUserQuestion
---

驱动 **issue-orchestrator** skill，输入为 `$ARGUMENTS`。

- 参数是 tracker 记录 ID / URL → `tracker-record` 模式：经 tracker 适配器取记录、
  认领、下载截图，末端可回写记录。
- 参数是问题描述/报错/截图路径等直接证据 → `direct-evidence` 模式：不查 tracker，
  走 report-only，不回写不通知提出人。
- 无参数时先问用户要修什么。
- 已有运行状态时重新校验输入，从第一个未完成步骤恢复；绝不重复已完成的认领、
  MR/PR、报告、回写或通知。

严格执行三道门禁：方案确认 → 验证+用户测试 → 交付（推送/MR、部署、报告、回写、通知）。
不要停在代码、适用证据、E2E 覆盖分析、MR/PR 或 CI 任何一处——完成判定要求每个适用
步骤都是 `done` 或 `not-applicable`。

Gate ② 前把受影响用户路径交给独立 `e2e-check` 插件做 composed 检查：持久化
`issue-fixer-e2e/v1` 结果到 `<runDir>/e2e-result.json`，MR 与报告复用前用
`result.mjs read` 校验 issueId + 问题指纹 + 当前仓库 `diffHash` + 回执 SHA-256。
过期交接只重跑 E2E 阶段。Gate ② 收集用户手动测试结果（`passed` / 失败证据 /
具体环境 blocker / 显式 deferred）。

主流程默认不发现、不部署、不验证真实环境；交付后可邀请用户回复一个环境 lane 做一张
真实页面截图。任何一步 blocked/not-applicable 都如实标注，不静默降级。
