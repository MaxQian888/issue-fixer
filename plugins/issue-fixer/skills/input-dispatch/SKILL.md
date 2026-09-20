---
name: input-dispatch
description: 需求进门的端到端处理流——识别需求来源与分量，分流到对应执行路径，再按阶段推进到 MR/PR。当用户交来一个要实现/修复/处理的需求（tracker 记录、工作项、文档、设计稿、口头描述，"修复这个""处理这个需求""实现这个"）时使用。纯排查类输入（CI 挂了、线上任务出错、性能断言）由本表直接路由到排障入口，不进开发流。
---

# 需求处理流

前门 skill：只做分流与阶段推进，执行细节在各子 skill。协作契约（确认边界、推送授权、
验证力度）见 `repo-collab`。

## 0. 分流

需求进门先定去向，**每个输入只走一条路**：

| 输入 | 条件 | 去向 |
|---|---|---|
| tracker 记录选择器/链接（`/fix-issue`） | tracker 已配置 | `issue-orchestrator` 的 tracker-record 模式 |
| 问题描述 + 证据（截图/报错/复现） | 描述明确、要求修复 | `issue-orchestrator` 的 direct-evidence 模式 |
| 工作项/工单（`/fix-workitem`，外部工作项系统 URL 或 ID） | 描述明确、改动面小 | `workitem-quick-fix`（worktree→修→验→交 直达） |
| 工作项/工单 | 功能/大改、含设计 | 本流 1→5 |
| 口头描述 / 文档（`/worktree-start`） | 新功能、优化、研究 | 本流 1→5 |
| "看看是不是问题" + 论断（`/verify-claim`） | 待验证的 claim | `claim-verify-first`；证实才回本流或 orchestrator |
| "分析/研究/梳理 X，先不改" | 纯分析 | 读码分析 → 产出文档或对话结论，**到此为止** |
| "做个原型/先探索下 X 怎么做"（`/prototype`） | 方案/交互/状态模型需要打样验证 | `prototype`（一次性产物，不进交付 diff） |
| 设计稿 + 实现意图 | 设计还原 | 本流；设计稿解析按 worktree-flow 的 sources.md |
| MR/PR URL + 续作/rebase/修CI（`/branch-sync`） | 已有分支的维护 | `branch-sync` / 仓库 CI 排障入口 |
| 线上任务 URL | 线上排障 | 仓库自己的 run/日志排障工具 |
| pipeline / "CI 为啥挂" | CI 事故 | 仓库的 CI 排障 skill/命令 |

工具型输入同样直达对应 skill，不进本流：清理 worktree → `/worktree-clean`；
只定位 UI 问题 → `/localize-ui`；补截 before/after → `/capture`；重出修改报告 →
`/fix-report`；E2E 覆盖检查 → `/check-e2e`；修 tracker 记录/证据问题全流程 → `/fix-issue`。

分量拿不准按大处理（先对齐方案）——返工比被问更烦人。

- **完成判据**：每个输入指认了唯一去向；进本流的写明分量判定（小/中/大）与一句话理由。

## 1. 理解需求

- 按来源读全需求材料；写出验收点清单，每条可检验。
- 方案有分叉/需求含糊 → 一条消息把问题问完；大需求先出方案（评审类材料按仓库惯例）；
  交互形态或状态模型拿不准、值得先打样验证的 → `prototype`，把原型结论带进方案。
- **完成判据**：验收点清单成型；方案分歧已闭合（用户拍板或无分叉）。

## 2. 开工

- 新任务 → `worktree-flow`（取基线、建 `{repoParent}/{repoName}-<slug>`）。
- 已有分支/worktree → `branch-sync`（定位、rebase、冲突）。
- **完成判据**：干净 worktree 就位，HEAD 在正确基线上。

## 3. 实现 + 验证

- 实现与验证档位由 `worktree-flow` 第 4–5 步和 `references/verify-matrix.md` 管。
- **完成判据**：验收点逐条有对应改动与验证证据。

## 4. 收尾链

按用户指令边界逐段执行，不自动推进：

1. "提交" → 仓库自己的提交约定（Conventional Commit / 提交钩子），"按模块提交"则按
   包/模块拆 commit，不遗漏文件。
2. "推送 / 建 MR" → `scripts/mr.mjs`（forge 适配器；`git` 兜底给出手动指引）；
   工作项来源 → 用 tracker/forge 的关联机制回填。
3. MR 落地后 → 提醒 CI 在跑；挂了就地走仓库的 CI 排障入口。
4. **大改动** → 主动提议自测文档（覆盖 MR 全部改动面）。
- **完成判据**：MR 链接（或"停在本地"状态）+ 验证证据已交付。

## 5. 后置

- worktree 默认在保（远程有 open MR）；清理走 `worktree-cleaner`。
- 环境部署跟踪：走 `deploy` 配置命令或仓库 pipeline 工具按分支/commit 找 run。
