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

创建或恢复一份可恢复运行状态，包含：来源模式、问题指纹、分类、规模档、结局、路由、
选择器、基线 SHA、worktree 路径 + 分支、产物目录（`<runDir>`）、每一步状态、产物、
阻塞点，以及精确的恢复动作。一律经 `scripts/lib/runstate.mjs` 的 CLI
（`fingerprint | init | set | meta | gate | show | resume | progress`）读写，步骤 id
只用其规范步骤表（见下方工作流）。

步骤状态只用：`pending | running | done | blocked | failed | not-applicable`。
"Continue"/"继续" 指重新校验输入后从第一个未完成步骤恢复。绝不重复已完成的认领、
MR/PR、报告、回写或通知。

每次步骤流转时把进度清单（`runstate.mjs progress <runDir>` 生成的 `fixer:progress`
块）输出到 assistant 正文；工具 stdout 不算流的一部分。

## 规模档与结局

- **档**（S/M/L/XL）衡量改动复杂度与风险，只决定每步做多深（复现深度、根因深度、
  红灯要求、复核方式、熔断预算），绝不删步骤。分诊定初档，Gate ① 定正式档，运行中
  只升不降、升档即回 Gate ①。XL 不在流水线里修——出方案（`tech-proposal`）。
  判档表：`plugins/issue-fixer/skills/issue-orchestrator/references/sizing.md`。
- **结局**（`fixed | already-fixed | cannot-reproduce | not-a-bug | duplicate |
  needs-decision | external | escalated | split | abandoned`）在 Gate ① 批准。只有
  `fixed` 走改码段；`abandoned` 不出报告，其余以带证据的调查报告收尾；tracker 状态值由人
  在 Gate ③ 选。
- 步骤不适用只有四种来源：来源模式、结局、门禁答复（Gate ② `keep-local`、Gate ③
  `declined`）、能力缺失（如无可查询的 CI）——每个都带原因落盘。档从不决定适用性。
- 证据推翻已完成的步骤（手测失败、复核判未修复、CI 由改动引起、评审意见、基线前进、熔断、
  升档、结局变化）时用 `runstate.mjs reopen <step>` 回退：其后步骤全部重走，被回退的门禁
  进入新一轮重新提问，外向产物（分支、MR、报告、记录）原地更新不新建。Gate ① 批准后改档
  或改结局必须先 reopen。

## 提问与门禁

每个门禁与解锁请求都用运行时的原生提问能力。一次只问一个聚焦问题；说清什么被阻塞、
最小的用户动作、以及恢复的是哪一步。绝不让用户粘贴 cookie、token、私钥或浏览器
状态内容。沉默不等于批准。

只有三个门禁：

- 🚦 **Gate ①** —— 批准指纹 + 档 + 复现 + 根因因果链 + 定位 + 结局 + 方案（可见界面
  还要定精确的 `productEntryUrl`/路由）。此前不建分支、不编辑、不截图、不推送、不建 MR/PR。
- 🚦 **Gate ②** —— 推送与 MR/PR 前：展示 diff 摘要、红灯→绿灯、E2E 决策/结果、复核
  裁决，以及 e2e-check 给出的精确 `manualTestPrompt`；接受 `passed`、第一个失败步骤 +
  证据、具体环境阻塞，或显式 deferred。推送只在本门禁批准之后，且只覆盖卡片里展示过的
  diff；之后任何代码改动都重过本门禁再推。
- 🚦 **Gate ③** —— 仅 `tracker-record`：批准 tracker 回写 + 通知。

卡片内容与选项固定：`plugins/issue-fixer/skills/issue-orchestrator/references/gates.md`。

## 工作流

括号里是 `runstate.mjs` 的规范步骤 id。每步有完成判据，未满足不进下一步。

1. 取证（`intake`）：分流输入（见上）；收集全部原始证据；用 `runstate.mjs fingerprint`
   构建问题指纹（`recordId` + 问题描述 + 功能模块 + 优先级 + 原始截图，或 `source=direct` +
   逐字描述 + 所供证据）；建运行状态。
2. 分诊定档（`triage`）：分类（UI → `ui-issue-localize`；报错/后端/数据/性能/配置/
   安全 → 日志驱动定位；含糊 → 动代码前先问）；定初档；检查多问题拆分与重复/并行。
3. 复现（`reproduce`）：不改代码地在基线上看到症状；需要运行 `origin/<base>` 时用
   `<runDir>/probe` 下的 detached 探针 worktree；复现不了做 IS / IS NOT 对照。
4. 定位（`locate`）：`file:line` + 路由 + selector，需两个独立锚点（gate ① 要求
   `high`/`medium` 置信度；`low` → 先问）；写因果链，M/L 档加引入提交、影响面、同类缺陷。
5. 🚦 Gate ①（`gate1`）。结局非 `fixed` 时直接跳到第 18 步（`abandoned` 跳过报告）。
6. 隔离（`worktree`）：`git -C <FIXER_REPO_DIR> fetch origin <base>`；
   `BASE=$(rev-parse origin/<base>)`；按 `worktree.dirTemplate`/`branchPrefix`
   建 worktree。在 worktree 内验证 HEAD == $BASE，然后装依赖。之后所有改动、
   验证、E2E、提交命令都以 worktree 为 cwd；主 checkout 保持不动。
7. 基线（`baseline`）：跑一次未改动基线的 lint/typecheck 并留存输出。
8. 红灯（`red`）：产品代码还在 `$BASE` 时让问题可观察地失败——回归测试、UI 的
   `before` 产物与实测属性、脚本化复现或性能基线。
9. 改码（`fix`）：施加最小的已批准改动直到红灯转绿；每轮假设记进假设日志，达到档的
   熔断预算即回 Gate ①。
10. 验证（`verify`）：按 `worktree-flow` 的 verify-matrix：样式/文案 → lint + 视觉证据；
    逻辑/缺陷 → 最窄归属层测试 + 受影响包 build/typecheck；用户可见或协议变更 →
    E2E 阶段；性能 → 实测前后数据；档再叠加深度。改动文件的新错误是阻塞项；既有失败
    单列，绝不说成 "pass"。
11. 证据（`evidence`）—— 选能呈现所报状态的最便宜通道：
    - `simulated-component`（默认）：确定性 fixture，两修订间参数完全一致，
      `SIMULATED` 水印，附 `compare.html` 与 `conversationMarkdown`。
    - `local-dev`：fixture 表达不了该状态时 —— worktree 上一个常驻 dev server
      连远程后端，标注 `live local dev + remote backend`。
    - `real-env`：仅完成后的可选后续，需要已确认的环境 lane 与
      `productEntryUrl` + `capture.envHeaders`。
    - 非 UI：行为验证说明（复现 → 红灯 → 绿灯）。
12. E2E 覆盖（`e2e`）：用 $BASE、worktree diff、指纹和路由调用 `e2e-check`（独立插件）。
    持久化 `<runDir>/e2e-result.json`；MR/报告复用前重新 snapshot，并用
    `result.mjs read` 校验 issueId + 指纹 + 当前 `diffHash` + SHA-256。不匹配
    即为过期交接——只重跑 E2E 阶段。`blocked` → 问记录的问题并恢复该插件。
13. 复核（`review`）：S 档逐条自查；M/L 档用独立上下文的 `bugfix-review`。复核后的任何
    编辑回到第 12 步。
14. 提交（`commit`）：在 worktree 内提交，不推送。只暂存映射到验收点的文件——先
    `git status`。
15. 🚦 Gate ②（`gate2`，用户测试 + 推送/MR 批准）。前置检查：基线新鲜度（落后且冲突 →
    rebase 并重跑验证/E2E/复核）、E2E 交接仍有效、复核已记录。
16. 推送 + MR（`publish`）：批准后 `git push -u origin HEAD`，经 forge 适配器
    （`scripts/mr.mjs create`）建指向 `baseBranch` 的 **Draft** MR/PR；同一 head
    已有则更新而非重复建。`forge.type=git` 时返回推送/建单指令——如实报
    `pending`，不假装已建。
17. CI（`ci`）：拉完整失败日志，分类 `caused-by-change | pre-existing | flaky |
    infrastructure | unknown`，可信 flake 最多重跑一次并等终态。
18. 报告（`report`）：经 `fix-report` 出报告（report 适配器）；结局非 `fixed` 时出调查报告。
19. 仅 `tracker-record`：🚦 Gate ③（`gate3`）。
20. 仅 `tracker-record`：回写 + 通知（`writeback`）。`direct-evidence` 下这两步为
    `not-applicable`。
21. 完成审计（`audit`，见下）。

回归、无法复现、多问题、安全、数据修复、基线漂移、热修复分支、外部根因等分支情形见
`plugins/issue-fixer/skills/issue-orchestrator/references/situations.md`。

## Before/After 证据契约

有效对比要求：真实的改前与改后修订；路由、selector、视口、主题、语言、数据/账号、
feature flag、滚动位置、交互状态完全一致；目标 selector 两次都找到；两次截图都不
是认证墙；产物非空；可行时给出实测的变化属性。单有一张生成的 PNG 不是证据。

把返回的 `conversationMarkdown` 逐字渲染进对话正文——用绝对本地图片路径，绝不写
"图" 字或占位链接。

## 完成判定

绝不仅仅因为代码改了、有截图、有 MR/PR、或请求了 CI 重跑就说"修好了/完成"。
完成要求每个适用步骤都是 `done` 或 `not-applicable`（`runstate.mjs resume` 返回
`complete`）。结局 `fixed`：已批准的定位与方案、红灯→绿灯、有效 before/after 证据
（非 UI 则为书面限制说明/行为说明）、无新增 lint/类型错误 + 针对性行为检查、校验过的
当前 diff E2E 交接、复核裁决、已记录的手测结果（`passed` 或显式 `deferred`）、已推送
commit 与 Draft MR/PR（forge=git 时如实 pending；用户在 Gate ② 选 `keep-local` 时为本地
提交 sha）、必需 CI 终态（或带原因的不适用）、已发布报告，以及——
仅 `tracker-record`——已批准的回写 + 通知。无改动结局：Gate ① 批准的结局与证据、已发布
的调查报告（`abandoned` 除外），以及——仅 `tracker-record`——Gate ③ 的答复与对应回写。所有结局：每步达到
该档的最低深度，`followUps` 已列出。

若适用步骤 `blocked`：保留运行状态、单独汇报已完成部分、问最小的一个解锁动作、
并指明精确的恢复步骤。完成后 MR/PR 未关期间 worktree 保留；删除只能经
`worktree-cleaner` 且需用户确认。唯一例外是本 run 自己在 `<runDir>/probe` 建的 detached
探针 worktree：干净时在完成审计里直接 `git worktree remove`，有任何改动就保留并报告。

## 维护者备忘

- 改了 `skills/`、`commands/`、`hooks/` 后必须重新生成 Cognia 产物：
  `pnpm build:cognia`（需要 `FIXER_COGNIA_CONVERT` 指向 plugin-convert bundle
  或已安装的 `cognia` CLI），`pnpm check:cognia` 校验漂移，
  `pnpm validate:plugins` 做离线结构与 parity 校验。
- commands/*.md 是给 agent 的 prompt 模板：不要写 `$ARGUMENTS`/`$1` 替换记号
  （Cognia 转换器不支持），用"本次命令附带的参数"这类自然语言。
- frontmatter 是严格 YAML：含 `[`、`]`、`:`、`{}` 的值必须加引号。
