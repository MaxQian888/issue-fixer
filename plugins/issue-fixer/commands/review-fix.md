---
description: 独立复核当前 diff/commit 是否真正修复所报告的问题（因果链裁决，不携带先前诊断）。
argument-hint: "<问题描述或 diff 范围>"
allowed-tools: Bash, Read, Grep, Glob, Task
---

驱动 **bugfix-review** skill，输入为本次命令附带的参数（无参数时复核当前工作区改动，
并先问问题描述）。

复核必须在独立上下文中进行：子代理只拿问题描述、待审 diff、评审规则——不要给它你的
诊断过程或期望结论。裁决三选一：从代码看已修复 / 从代码看未修复 / 暂无法确认是否修复。
