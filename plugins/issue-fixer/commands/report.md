---
description: 汇编并发布一次修复的修改报告；direct-evidence 为 report-only，tracker-record 在 gate ③ 后可回写记录并通知提出人。
argument-hint: "[--mode report-only|tracker-writeback] [recordId]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **fix-report** skill，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

`report-only`（默认）：构建 markdown 报告并经 `report` 适配器发布。
`tracker-writeback`：额外执行 tracker 记录更新、附件上传、提出人通知——三者各自
独立标注 done/blocked/not-applicable。
