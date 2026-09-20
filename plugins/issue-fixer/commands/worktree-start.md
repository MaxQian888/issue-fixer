---
description: 为一个问题从最新基线建独立 worktree 与任务分支，主 checkout 不动。
argument-hint: <issue-slug> [--type fix|feat|chore]
allowed-tools: Bash, Read, Grep, Glob
---

驱动 **worktree-flow** skill 的建树部分，输入为 `$ARGUMENTS`。

从 `repo.path` 指向的主 checkout fetch 配置的 base 分支，以 `origin/<base>` 建兄弟
worktree `../<repo>-<slug>` 与分支 `<type>/<slug>`，验证 HEAD == 基线 SHA，按 worktree
的 packageManager 装依赖。之后所有命令以 worktree 为 cwd。
