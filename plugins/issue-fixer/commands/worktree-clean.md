---
description: 列出本插件创建的 worktree 并清理已完成/已废弃的；每个删除都要用户确认。
argument-hint: "[--dry-run]"
allowed-tools: Bash, Read, Grep, Glob
---

驱动 **worktree-cleaner** skill，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

扫描主 checkout 的 `git worktree list`，筛出本插件命名模式（`fix/`、`feat/` 等前缀 +
兄弟目录）的 worktree；逐个展示分支状态（已合并/有未推送 commit/有未提交改动），
逐一询问确认后才 `git worktree remove`。有未推送或未提交内容的分支默认不删。
