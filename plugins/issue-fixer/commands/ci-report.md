---
description: 生成 CI 日报/周报（GitHub Actions 优先）：失败聚类、覆盖率警告、可选发布与群摘要。
argument-hint: "--kind daily|weekly [--period|--since/--until] [--repo o/r] [--ref b] [--tz tz] [--publish] [--chat-id id] [--dry-run]"
allowed-tools: Bash, Read, Write, Grep, Glob
---

驱动 **ci-report** skill，输入为本次命令附带的参数。

默认采集器是 GitHub CLI：`gh run list` 枚举窗口内执行，失败 run 再拉
`gh api` detail/jobs 与 `--log-failed` 日志（仅内存）。发布走 `report.type`
适配器，群摘要走 notify 适配器——都不硬编码平台。原始日志与凭据绝不落盘；
覆盖缺口必须写进报告，不得声称全量。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/ci-report.mjs --kind daily --dry-run
```
