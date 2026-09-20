---
description: 把一条 UI 问题（描述/截图/模块）定位到精确的源码 file:line 与最小改动方案，带置信度。
argument-hint: [recordId 或直接证据]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task, AskUserQuestion
---

驱动 **ui-issue-localize** skill，输入为 `$ARGUMENTS`。

只定位、只提案：输出 `file:line`、置信度、证据锚点、备选归属、最小改动方案与耦合值。
不做编辑；编辑归 issue-orchestrator 的 gate ① 之后。
