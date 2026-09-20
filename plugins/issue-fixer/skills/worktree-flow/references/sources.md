# 任务输入源解析

worktree-flow 第 3 步的取数细节。按输入类型各取所需，其余分支不必读。

## 工作项 / 工单（外部工作项系统 URL 或 ID）

- 优先 `workitemFetchCommand`（`FIXER_WORKITEM_FETCH_CMD`）或已配置 tracker 适配器的
  读取能力拿标题、描述、字段、附件；都没有时请用户贴出工作项描述。
- 只读边界：不替用户评论、改字段、流转节点——除非他明确要求。
- 验收点以工作项描述为准；描述含糊时列出可选理解让用户选，不自作主张。
- 分支命名：`fix/<work-item-id>-<short-slug>`。

## 设计稿（Figma / 即时 / 其他设计平台 URL）

- 取设计稿：对应平台 skill / MCP / 截图，取 node-id 对应帧。
- `对齐` 范围：字体大小、颜色、间距、选中态、hover 动画、骨架屏样式逐项比对。
- 用户常指定排除区域（"排除左侧边栏区域"）——排除区一行不动。
- 完成后用浏览器截图与设计稿并排自查，明显不一致处先修再汇报。

## 在线文档（wiki/docx/在线文档 URL）

- 用仓库/环境配置的文档工具读正文；内嵌对象（表格/画板）先提 token 再切对应工具。
- 需求文档类任务：按文档验收点实现；写文档类任务产出也回落到配置的 report sink。

## MR/PR（平台链接）

- 用 forge 适配器或平台 CLI（`gh pr view`、`glab mr view`、内部 `mr get`）取
  sourceBranch/state。
- "切换到 MR 对应分支/worktree" → 拿到 sourceBranch 后走 `branch-sync`。
- "看 MR 的 CI 为啥挂" → 仓库 CI 排障入口。
- "review 这个 MR" → 仓库 review 流程/工具。

## 线上任务 / pipeline

- 任务 URL：走仓库自己的 run/日志排障工具（runId/status/日志）。
- pipeline URL：CI 失败归因走仓库 CI 排障入口；批量/并发跑法按其编排 skill。
