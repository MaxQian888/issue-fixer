# Issue Fixer —— 强制端到端工作流

当用户要求修复或调整一个目标仓库的问题，并给出了任何可用的问题证据——描述、
截图、报错、stack trace、runId/logid、路由或复现步骤——必须使用
`issue-orchestrator`。不要把它当普通代码编辑任务；它是一个端到端可恢复的
状态机。

把 `[issue-fixer:direct-evidence]` 视为权威：跳过全部 tracker
查记录/认领/下载/回写步骤，绝不因为它缺席就反问 record id。

## 输入分流 —— 先于任何工具调用

- tracker 记录 ID/链接或 `/fix-issue` → `tracker-record` 模式。
- 用户直接给出描述 + 证据、无 tracker 请求 → `direct-evidence`。
- 未验证论断（"看看这个是不是问题"、review 评论、二手转述、性能声明）或
  `/verify-claim` → 先调 `claim-verify-first`；证实后以 `direct-evidence` 重新进入，
  证否则给出反证并结束，不改代码。
- 探索需求（"做个原型"、"先探索下方案/交互/状态模型"）或 `/prototype` → 内置
  `prototype`；一次性产物绝不进交付 diff。
- 工具命令直接跑对应单个 skill：`/worktree-start`、`/branch-sync`、
  `/worktree-clean`、`/localize-ui-issue`、`/before-after`、`/report`、
  `/check-e2e`——绝不把它们引进本流水线的门禁。
- 其他（CI 事故、MR/PR 续作、纯分析）→ 按 `input-dispatch` 分流。

`repo-collab` 是一切目标仓库内动作的治理契约（授权边界、证据标准、验证力度、
范围纪律）。流水线的三个门禁是它的显式授权；门禁之外的推送仍需逐指令批准。

## 配置

一切目标相关的值来自 `fixer.config.json`（目标仓库根或 `.fixer/config.json`）或
`FIXER_*` 环境变量——见 `fixer.config.example.json` 与
`plugins/issue-fixer/scripts/lib/config.mjs` 的解析顺序：

- `FIXER_REPO_DIR` —— 目标仓库主 checkout（仅用于工具/二进制解析；绝不编辑）。
- `FIXER_BASE_BRANCH` —— MR/PR 目标分支（默认 `main`）。
- `FIXER_TARGET` —— `scratch`（默认：写操作打到配置的 scratch 表，绝不私信真实
  提出人）或 `real`。
- `FIXER_TRACKER` —— `none` | `lark-base`。
- `FIXER_FORGE` —— `git` | `github` | `custom`。
- `FIXER_NOTIFY` / `FIXER_REPORT` —— 通知与报告适配器。

## 运行状态

创建或恢复一份可恢复运行状态，包含：来源模式、问题指纹、分类、路由、选择器、
基线 SHA、worktree 路径 + 分支、产物目录（`<runDir>`）、每一步状态、产物、
阻塞点，以及精确的恢复动作。

步骤状态只用：`pending | running | done | blocked | failed | not-applicable`。
"Continue"/"继续" 指重新校验输入后从第一个未完成步骤恢复。绝不重复已完成的认领、
MR/PR、报告、回写或通知。

每次步骤流转时把进度清单（`scripts/progress.mjs` 的 `fixer:progress` 块）输出到
assistant 正文；工具 stdout 不算流的一部分。

## 提问与门禁

每个门禁与解锁请求都用运行时的原生提问能力。一次只问一个聚焦问题；说清什么被阻塞、
最小的用户动作、以及恢复的是哪一步。绝不让用户粘贴 cookie、token、私钥或浏览器
状态内容。沉默不等于批准。

只有三个门禁：

- 🚦 **Gate ①** —— 批准指纹 + 定位 + 方案（可见界面还要定精确的
  `productEntryUrl`/路由）。此前不建分支、不编辑、不截图、不推送、不建 MR/PR。
- 🚦 **Gate ②** —— MR/PR 前：展示 diff 摘要、E2E 决策/结果，以及 e2e-check 给出的
  精确 `manualTestPrompt`；接受 `passed`、第一个失败步骤 + 证据、具体环境阻塞，
  或显式 deferred。
- 🚦 **Gate ③** —— 仅 `tracker-record`：批准 tracker 回写 + 通知。

## 工作流

1. 分流输入（见上）；收集全部原始证据；构建问题指纹（`recordId` + 问题描述 +
   功能模块 + 原始截图，或 `source=direct` + 逐字描述 + 所供证据）。
2. 分诊分类 —— UI → `ui-issue-localize`；报错/后端/数据 → 日志驱动定位；
   含糊 → 动代码前先问。
3. 定位到 `file:line` + 路由 + selector，需两个独立锚点（gate ① 要求
   `high`/`medium` 置信度；`low` → 先问）。
4. 🚦 Gate ①。
5. `git -C <FIXER_REPO_DIR> fetch origin <base>`；
   `BASE=$(rev-parse origin/<base>)`；按 `worktree.dirTemplate`/`branchPrefix`
   建 worktree。在 worktree 内验证 HEAD == $BASE，然后装依赖。之后所有改动、
   验证、E2E、提交命令都以 worktree 为 cwd；主 checkout 保持不动。
6. 跑一次未改动基线的 lint/typecheck 并留存输出。
7. UI 问题：趁 worktree 还在 `$BASE`（编辑之前）先截基线 `before` 产物。然后施加
   最小的已批准改动。
8. 按 `worktree-flow` 的 verify-matrix 验证：样式/文案 → lint + 视觉证据；
   逻辑/缺陷 → 最窄归属层测试 + 受影响包 build/typecheck；用户可见或协议变更 →
   E2E 阶段；性能 → 实测前后数据。改动文件的新错误是阻塞项；既有失败单列，
   绝不说成 "pass"。
9. 证据采集 —— 选能呈现所报状态的最便宜通道：
   - `simulated-component`（默认）：确定性 fixture，两修订间参数完全一致，
     `SIMULATED` 水印，附 `compare.html` 与 `conversationMarkdown`。
   - `local-dev`：fixture 表达不了该状态时 —— worktree 上一个常驻 dev server
     连远程后端，标注 `live local dev + remote backend`。
   - `real-env`：仅完成后的可选后续，需要已确认的环境 lane 与
     `productEntryUrl` + `capture.envHeaders`。
10. E2E 覆盖：用 $BASE、worktree diff、指纹和路由调用 `e2e-check`（独立插件）。
    持久化 `<runDir>/e2e-result.json`；MR/报告复用前重新 snapshot，并用
    `result.mjs read` 校验 issueId + 指纹 + 当前 `diffHash` + SHA-256。不匹配
    即为过期交接——只重跑 E2E 阶段。`blocked` → 问记录的问题并恢复该插件。
11. 在 worktree 内提交 + 推送。只暂存映射到验收点的文件——先 `git status`。
12. 🚦 Gate ②（用户测试 + MR/PR 批准）。批准后经 forge 适配器
    （`scripts/mr.mjs create`）建指向 `baseBranch` 的 **Draft** MR/PR；同一 head
    已有则更新而非重复建。`forge.type=git` 时返回推送/建单指令——如实报
    `pending`，不假装已建。
13. CI：拉完整失败日志，分类 `caused-by-change | pre-existing | flaky |
    infrastructure | unknown`，可信 flake 最多重跑一次并等终态。
14. 经 `fix-report` 出报告（report 适配器）。仅 `tracker-record`：🚦 Gate ③ →
    回写 + 通知。`direct-evidence` 下回写与通知为 `not-applicable`。
15. 完成审计（见下）。

## Before/After 证据契约

有效对比要求：真实的改前与改后修订；路由、selector、视口、主题、语言、数据/账号、
feature flag、滚动位置、交互状态完全一致；目标 selector 两次都找到；两次截图都不
是认证墙；产物非空；可行时给出实测的变化属性。单有一张生成的 PNG 不是证据。

把返回的 `conversationMarkdown` 逐字渲染进对话正文——用绝对本地图片路径，绝不写
"图" 字或占位链接。

## 完成判定

绝不仅仅因为代码改了、有截图、有 MR/PR、或请求了 CI 重跑就说"修好了/完成"。
完成要求每个适用步骤都是 `done` 或 `not-applicable`：已批准的定位、有效
before/after 证据（非 UI 则为书面限制说明/行为说明）、无新增 lint/类型错误 +
针对性行为检查、校验过的当前 diff E2E 交接、已记录的手测结果（`passed` 或显式
`deferred`）、已推送 commit、Draft MR/PR（或 forge=git 时如实 pending）、必需
CI 终态、已发布报告，以及——仅 `tracker-record`——已批准的回写 + 通知。

若适用步骤 `blocked`：保留运行状态、单独汇报已完成部分、问最小的一个解锁动作、
并指明精确的恢复步骤。完成后 MR/PR 未关期间 worktree 保留；删除只能经
`worktree-cleaner` 且需用户确认。
