---
description: 为一个问题从最新基线建独立 worktree 与任务分支，主 checkout 不动。
argument-hint: <issue-slug> [--type fix|feat|chore]
allowed-tools: Bash, Read, Grep, Glob
---

驱动 **worktree-flow** skill 的建树部分，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

从 `repo.path` 指向的主 checkout fetch 配置的 base 分支，以 `origin/<base>` 建兄弟
worktree `../<repo>-<slug>` 与分支 `<type>/<slug>`，验证 HEAD == 基线 SHA，按 worktree
的 packageManager 装依赖。之后所有命令以 worktree 为 cwd。

`worktree.mode=in-place` 时不建 worktree：留在主 checkout（或 `worktree.inPlaceBranch`
指定的分支），先盘 `git status --porcelain` 的未提交改动归属，之后命令以主 checkout
为 cwd。
