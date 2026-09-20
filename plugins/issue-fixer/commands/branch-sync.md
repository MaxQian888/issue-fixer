---
description: 把 fix worktree 的分支 rebase 到最新基线；冲突用最小语义修复，不动无关文件。
argument-hint: "[--base <branch>]"
allowed-tools: Bash, Read, Edit, Grep, Glob
---

驱动 **branch-sync** skill，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

在 worktree 内 fetch + rebase 到 `origin/<base>`；冲突按语义最小解（保留双方意图），
rebase 后重跑与该改动相称的验证。绝不 rebase 主 checkout 或无关分支。
