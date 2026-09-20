---
name: branch-sync
description: 把目标仓库的分支或 MR/PR 切到对应 worktree（缺则建）、同步远程、rebase 到最新基线、处理冲突、按需推送。触发语"切换到 X 对应的worktree""rebase到最新的dev/main分支，处理冲突""拉取远程分支创建worktree""改为基于最新的main分支重新创建mr"。全新任务开 worktree 走 worktree-flow。
---

# 分支同步 / Rebase 流

协作契约（确认边界、推送授权）见 `repo-collab`；冲突确认口径以本文件第 4 步为准。
`<repo>` = `FIXER_REPO_DIR`，`<base>` = `FIXER_BASE_BRANCH`。

## 1. 定位分支与 worktree

```bash
git worktree list                        # 已有 worktree
git branch -a                            # 本地/远程分支兜底
# MR/PR URL/编号/源分支名：用 forge 适配器或平台 CLI 解析（gh pr view / glab mr view /
# 仓库内部 mr get）
```

- **完成判据**：拿到唯一 (worktree 路径, 分支) 对，或明确要走"新建"分支。

## 2. 进场

- 有 worktree → `git -C <wt> status`：有未提交改动先报告现场内容，等用户指示后再动。
- 无 worktree、有远程分支 → `git fetch origin <b>` 后
  `git worktree add ../<repoName>-<slug> -b <b> --track origin/<b>`。
- 无 worktree、无分支 → 问用户是名字给错了还是要新建。
- **完成判据**：cwd = 目标 worktree，`git branch --show-current` 正确，工作区状态已记录。

## 3. 同步 + rebase

```bash
git fetch origin <base>
git rev-parse HEAD        # 记 pre-rebase 点，后悔药
git pull --ff-only        # 跟踪远程分支的先对齐远程
git rebase origin/<base>  # 或用户指定基线
```

- 换基线（"改为基于最新的 main"）→ `git rebase --onto origin/main origin/<base>`；
  MR 目标分支随基线变的，重建 MR 走 forge 适配器。
- rebase 失败想回退 → `git rebase --abort` 或 `git reset --hard <pre-rebase-SHA>`。
- **完成判据**：`git status` clean 且 HEAD 在目标基线之上；否则进第 4 步。

## 4. 冲突（确认契约）

- **`都保留` 类直接合**：双方改动是语义叠加（各加各的导出、各加各的 case、文件不同段落）
  → 保留双方，不询问。
- **需确认类**：语义二选一、删一边功能才能合、意图读不懂 → 一条消息列全部冲突点 +
  每处推荐方案，一次问完。
- 常见冲突模式的处置见 [references/conflict-playbook.md](references/conflict-playbook.md)
  （lockfile、生成产物、同函数改写等）。
- 每个文件合完即 `git add`，全部合完 `git rebase --continue`。
- **完成判据**：`git status` 无 unmerged 条目；每个冲突文件经 `git diff` 目检无残留标记
  与误删。

## 5. 验证 + 推送

- `git diff origin/<base> --stat` 过最终改动面；rebase 带入依赖变化时在 worktree 内重跑
  `verify.install`。
- 冲突涉及逻辑代码 → 最窄相关测试；纯界面/文档冲突 → lint + 构建即可。
- 用户说"并且推送"→ `git push --force-with-lease`；没说 → 汇报"已 rebase，N 处冲突
  （自动保留 M / 已确认 K），未推送"。
- **完成判据**：最终 diff 与用户意图一致；推送与否精确匹配当次指令。
