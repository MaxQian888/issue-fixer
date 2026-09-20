---
name: worktree-cleaner
description: 清理目标仓库本地 worktree 与分支。默认口径：远程还有打开 MR/PR 的分支在保，其余列入待删清单等确认。触发语"清理worktree""清除所有除了远程还有对应mr的worktree""清理现在不使用的worktree""释放这些"。
---

# Worktree 清理

默认口径：**远程还有打开 MR/PR 的分支在保**，其余可删。删除不可逆，清单先确认再执行。
`<repo>` = `FIXER_REPO_DIR`。

## 1. 盘点

```bash
cd <repo>
git worktree list --porcelain
```

每个非主 worktree 收集：路径、分支、`git -C <path> status --porcelain`（未提交改动）、
`git rev-list --count origin/<b>..<b>`（未推送 commit 数）。

- **完成判据**：每个非主 worktree 都有（路径， 分支， 脏/净， 未推送数）四元组；
  主 checkout 跳过。

## 2. 逐条判定在保

```bash
git ls-remote --heads origin <branch>
# MR/PR 状态用 forge 适配器或平台 CLI 查（gh pr list --head <branch> / glab mr list /
# 仓库内部 mr list）；查不到平台时以"远程分支存在 + 未推送 commit"为在保依据。
```

- **在保**：远程有 open MR/PR / 有未推送 commit / 有未提交改动 / 用户点名保留。
- **可删**：其余。merged/closed MR 不算在保。
- **完成判据**：每个 worktree 标好 留/删 + 一句理由。

## 3. 清单确认

给用户一张表：路径 | 分支 | MR 状态 | 本地改动 | 建议。一次确认后批量执行。

- 用户给了过滤条件（"7月15号之前的"）且清点吻合时，仍列清单并标好建议，一次确认。
- **完成判据**：用户对清单说了"删/可以"类确认词。

## 4. 执行与汇报

```bash
git worktree remove <path>           # 干净 worktree
git worktree remove --force <path>   # 用户确认丢弃改动
git branch -D <branch>               # 用户要求连分支删时
git remote prune origin              # 收尾可顺带问
```

- 未推送 commit 的 worktree 删目录不删分支，commit 仍在——删分支前先确认分支也可弃。
- **完成判据**：`git worktree list` 只剩在保项；汇报删除数、各项保留原因、回收体积。
