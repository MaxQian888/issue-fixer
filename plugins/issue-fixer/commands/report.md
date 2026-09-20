---
description: 汇编并发布一次修复的修改报告；direct-evidence 为 report-only，tracker-record 在 gate ③ 后可回写记录并通知提出人。
argument-hint: [--mode report-only|tracker-writeback] [recordId]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **fix-report** skill，输入为 `$ARGUMENTS`。

`report-only`（默认）：构建 markdown 报告并经 `report` 适配器发布。
`tracker-writeback`：额外执行 tracker 记录更新、附件上传、提出人通知——三者各自
独立标注 done/blocked/not-applicable。
