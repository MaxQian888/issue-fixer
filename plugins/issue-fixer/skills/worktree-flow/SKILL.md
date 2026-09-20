---
name: worktree-flow
description: 在目标仓库基于最新远程基线开独立 worktree 完成任务：取基线、建 worktree、实现、按比例验证、汇报。触发语"基于最新的 main/dev 分支创建worktree""开worktree 实现/修复/研究 X""拉取远程分支创建worktree"；工作项、文档、设计稿、MR 链接也可作任务输入。已有 worktree 的续作与 rebase 走 branch-sync。
---

# Worktree 任务流

协作契约（授权边界、验证力度、仓库约定、推送需显式授权）见 `repo-collab`，本文件不重复。
`<repo>` = `FIXER_REPO_DIR`（目标仓库主 checkout），`<base>` = `FIXER_BASE_BRANCH`。

## 1. 定基线，建 worktree

```bash
cd <repo>
git fetch origin <base>          # 默认 FIXER_BASE_BRANCH；用户指定其它基线时换
BASE=$(git rev-parse origin/<base>)
git worktree add ../<repoName>-<slug> -b <type>/<slug> $BASE
```

- `基线` = 刚 fetch 的远程 SHA，不是本地分支头。
- worktree 放主仓同级；命名与分支前缀由 `worktree.dirTemplate`/`branchPrefix` 配置
  （默认 `../<repoName>-fix-<issueId>`、`fix/agent-<issueId>`；自由任务用
  `<repoName>-<slug>` + `<type>/<slug>`，type ∈ feat/fix/chore……）。
- 同名 worktree 已存在 → `git worktree list` 判归属：属本任务则复用，否则换 slug。
- 输入是远程分支（"拉取远程分支 X"）→ `git fetch origin X` 后
  `git worktree add ../<repoName>-<slug> -b X --track origin/X`。
- **完成判据**：`git -C <wt> rev-parse HEAD` == $BASE；`git -C <wt> branch --show-current`
  是预期分支；主 checkout 的 `git status` 与动手前一致。

## 2. 备环境

- 后续所有命令的 cwd 显式设为 worktree 根。
- worktree 内跑一次 `verify.install`（如 `pnpm install`——主仓的 post-merge hook 覆盖不到
  新 worktree）；未配置时按仓库包管理器惯例安装。
- 缺生成产物/跨包 dist 时按仓库文档补到最窄验证可跑为止。
- 读最近的 AGENTS.md（子包优先于根）。
- **完成判据**：目标包的测试/构建入口在 worktree 内可用。

## 3. 解析任务输入

| 输入 | 解析方式 |
|---|---|
| 工作项 URL/ID | `workitemFetchCommand` 或 tracker 适配器读描述与附件；只读 |
| 设计稿 URL | 取设计稿逐项对齐；遵守排除区域 |
| 文档链接 | 仓库配置的文档工具读正文 |
| MR/PR URL | forge 适配器/平台 CLI 取 sourceBranch |
| 线上任务 URL | 排障类转仓库的 run/日志排障工具 |
| pipeline URL | 转仓库的 CI 排障入口 |
| 纯描述 | 直接复述验收点 |

各源的取数细节与鉴权注意见 [references/sources.md](references/sources.md)。

- **完成判据**：能写出本条任务的验收点清单，每条可检验；有分叉先确认再进第 4 步。

## 4. 实现

- 改动最小化，逐文件对应验收点。
- bug → 补回归用例；功能 → 补最窄 owning layer 测试。
- **完成判据**：`git status` 里每个文件都能指认对应验收点；diff 中无任务外改动。

## 5. 验证

档位按改动面选（契约见 repo-collab），各档命令表见
[references/verify-matrix.md](references/verify-matrix.md)。要点：watch 模式 runner 一律
显式 `run`；性能任务给前后实测。

- **完成判据**：所选档位的每条命令都实际执行且有输出；失败项要么修复，要么带证据标记为
  预存问题。

## 6. 汇报与收尾

- 汇报：worktree 路径、分支、基线 SHA、改动文件、执行过的命令与结果、遗留风险。
- "提交" → 仓库提交约定；"推送/建 MR" → push 后走 `scripts/mr.mjs`（forge 适配器，
  目标默认 `FIXER_BASE_BRANCH`）；未提 → 停在工作区。
- 用户要"本地前端远程后端测试" → `capture.devServerCommand` 起常驻 dev server，
  把本地 URL 交给用户。
