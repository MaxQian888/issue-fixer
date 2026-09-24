---
name: issue-orchestrator
description: >-
  端到端修复**一个**问题，输入可以是已配置 tracker 的一条记录或用户直接提供的证据。
  用户跑 /fix-issue、提到 tracker/工单问题、或发来带截图/报错/堆栈/runId/logid/
  复现步骤的问题描述并要求修复/调整时必须使用——即使没有 tracker、record_id 或"修复"字样。
  直接证据跳过 tracker 查询。流程：取证 → 分诊定档 → 复现 → 定位根因 → 方案门禁 →
  隔离 worktree 红灯→修复 → 验证 → 模拟 before/after → E2E 覆盖检查 → 复核 →
  用户测试/MR 门禁 → 推送/CI/报告，tracker 记录输入另有最后的回写门禁。规模档（S/M/L/XL）
  决定每步做多深；无需改码的结论（已修复、无法复现、符合设计、重复、外部根因）以调查报告
  收尾。非流水线输入（工作项、未验证论断、CI/MR/分析请求）委派给内置工作流 skills。
  真实环境截图是完成后的可选后续，需要显式 lane。
---

# issue-orchestrator

你在修复**一个**问题并产出一份完整、可评审的结果。复用已有能力——**不要**重新实现
MR/部署/截图/通知。

**脚本**在 `<plugin-root>/scripts`（本 skill 目录是 `<plugin-root>/skills/issue-orchestrator`）。
配置来自 `fixer.config.json` 与 `FIXER_*` 环境变量（见 README 与 `scripts/lib/config.mjs`）。
核心配置：`FIXER_REPO_DIR`（目标仓库主 checkout）、`FIXER_BASE_BRANCH`（MR 目标分支）、
`FIXER_TARGET`（`scratch`|`real`）、`tracker`/`forge`/`notify`/`report` 适配器块。
所有适配器经由 `scripts/lib/config.mjs` 的 `getConfig()` 解析——skill 里出现 `<cfg.*>`
即指该解析结果。

## 先解析路径与能力

从本 `SKILL.md` 推导 `<plugin-root>`；绝不假设当前工作目录就是插件。`FIXER_REPO_DIR`
解析为**目标仓库主 checkout**：它供给 worktree 来源（第 6 步）并承载
`capture.mjs` 的 playwright 二进制解析；编辑绝不发生在它里面。未配置时先问目标仓库路径。

本插件在 `<plugin-root>/skills/` 下内置了通用工作流套件——按 skill 名调用，随本包分发：

- `repo-collab` —— 治理契约：授权边界、证据标准、验证力度、前端约定、工具定位
- `input-dispatch` —— 输入分流表（每个请求走哪条路）
- `worktree-flow` / `branch-sync` / `worktree-cleaner` —— worktree 生命周期：从新鲜远程
  基线创建、续作/rebase/冲突、保留与清理
- `workitem-quick-fix` —— 带测试/E2E 保界的 tracker 工作项快速通道
- `claim-verify-first` —— 编辑前先用代码证据验证论断
- `prototype` —— 一次性打样：方案/交互形态/状态模型需要探索验证时先做可丢弃原型，
  结论带进门禁；原型代码不进交付 diff
- `ui-issue-localize` / `before-after-capture` / `fix-report` —— 定位、证据采集、报告
- `bugfix-review` —— 独立上下文复核"这份 diff 是否真修了所报问题"
- `tech-proposal` —— L 档方案文档与 XL 档升级

`repo-collab` 治理本流程中的每一个仓库内动作。流水线的三个门禁是它的显式授权；
门禁之外的一切（无关编辑、扩范围、流程未授权的推送）仍按契约执行。

目标仓库自己的 skills / 插件 / CLI 是首选能力，不是已安装的证明。调用前先确认它在当前
运行时可发现。缺席时用提供同样操作的文档脚本或仓库命令。不要仅因首选 wrapper 不可用
就声称步骤受阻。

**e2e-check** skill 归独立的 `e2e-check` 插件所有。Gate ① 前确认该插件已启用。
不可用时请用户启用/安装该插件；不要把它的工作流拷进本插件，也不要静默降级 E2E 步骤。

E2E 插件根目录从它被发现的 `SKILL.md` 解析，不是本插件根目录。其 `scripts/result.mjs`
是唯一的跨插件交接校验器。它的结果放在本轮产物目录 `<runDir>/e2e-result.json` 下；绝不把
该 skill 或脚本拷进本插件。

在仓库外建每轮产物目录，默认 `<repoParent>/.issue-fixer-artifacts/<issueId>/`
（`FIXER_ARTIFACTS_DIR` 可覆盖），存放问题指纹、复现记录、假设日志、基线日志、模型 JSON、
截图、对比页、报告 markdown。绝不提交该目录。

## 运行坐标——每轮都要定下来的五个判定

五个坐标互相独立，各管一件事；都写进运行状态，Gate ① 卡片逐项展示。

| 坐标 | 取值 | 何时定 | 决定什么 |
|---|---|---|---|
| **模式** | `tracker-record` \| `direct-evidence` | 第 1 步分流 | tracker 段（认领/回写/通知/Gate ③）是否适用 |
| **分类** | `ui` \| `runtime-error` \| `backend` \| `data` \| `performance` \| `config` \| `security` \| `unknown` | 第 2 步 | 定位方法、证据形态（截图 vs 行为验证说明） |
| **档** | `S` \| `M` \| `L` \| `XL` | 第 2 步初定，Gate ① 正式 | 每步的最低深度、复核方式、熔断预算——见 [references/sizing.md](references/sizing.md) |
| **改动面** | 纯样式/文案 \| 逻辑/缺陷 \| 用户可见/协议 \| 性能 | Gate ① | 验证档位（`repo-collab` 验证分级） |
| **结局** | `fixed` \| `already-fixed` \| `cannot-reproduce` \| `not-a-bug` \| `duplicate` \| `needs-decision` \| `external` \| `escalated` \| `split` \| `abandoned` | Gate ① 提议并批准 | 哪些步骤适用、报告类型——见 [references/outcomes.md](references/outcomes.md) |

**档只决定做多深，从不决定哪步不做。** 步骤不适用只有四种来源，每种都带原因写进运行
状态：模式（`direct-evidence` 没有回写）、结局（非 `fixed` 没有改码段）、门禁答复（用户在
Gate ② 选择留在本地、在 Gate ③ 拒绝回写）、能力缺失（例如没有可查询的 CI）。S 档照样走完
每个适用步骤，只是每步取该档的最低合格深度；不能因为"改动小"把适用步骤标 `not-applicable`。

## 运行状态

每一步按 `not-applicable | pending | running | done | blocked | failed` 跟踪。外向步骤
blocked 不抹掉已完成的本地工作。重新校验输入后从第一个未完成步骤恢复；不检查是否已成功
就不重复认领、MR 创建、报告发布或通知。

持久化到 `<runDir>/run-state.json`，一律经 `scripts/lib/runstate.mjs` 的 CLI 操作——
不要手写 JSON，不要写临时 node 脚本：

```bash
R=<plugin-root>/scripts/lib/runstate.mjs
node $R fingerprint --source <mode> --desc "<原文描述>" [--record-id <id>] [--module <m>] [--evidence <file> ...]
node $R init <runDir> --run-id <issueId> --mode <mode> --fingerprint <fp>
node $R set <runDir> <step> <status> [--note "<t>"] [--waiting-for "<解锁动作>"] [--artifact k=<abs path>]
node $R meta <runDir> [--classification <c>] [--tier <t> --reason "<命中信号>"] [--outcome <o> --reason "<证据>"] [--fix-kind <k>] [--base-sha <sha>] [--worktree <p>] [--branch <b>]
node $R meta <runDir> [--surface <style-copy|logic|user-visible-protocol|performance>] [--severity <sev1..sev4> --severity-source <inferred|reported>] [--route <r>] [--product-entry-url <u>] [--base-branch <b>] [--isolation <worktree|in-place> --start-branch <b>] [--manual-test <result> --manual-evidence "<t>"]
node $R gate <runDir> <gate1|gate2|gate3> <decision> --summary "<用户原话或要点>"
node $R gate-id <runDir> <gate>   # 当前轮次的 requestId 与该门禁允许的答复
node $R reopen <runDir> <step> --reason "<推翻后续步骤的证据>"
node $R show <runDir>      # 全部坐标 + 每步状态 + 恢复点
node $R resume <runDir>    # 第一个未完成步骤及其 waitingFor / reopenedBecause
node $R list [artifactsDir]  # 所有 run 及其恢复点——上下文丢失后找回 runDir
node $R progress <runDir>  # 由运行状态生成 fixer:progress 块
```

`blocked` 必须带 `--waiting-for` 指明解锁动作；手工标 `not-applicable` 必须带 `--note`
写明是哪个门禁答复或缺了什么能力。Gate ① 之前档与结局是提议，可以随时 `meta` 修改；
Gate ① 批准之后改档或改结局会被拒绝——先 `reopen`（升档 → `reopen gate1`；结局变化 →
`reopen locate`）。门禁答复只接受 `gate-id` 列出的那几个值，每个值的副作用（回退到哪一步、
哪些步骤随之不适用、手测结果）在同一次写入里生效，见 [references/gates.md](references/gates.md)；
CLI 拒绝不适用的门禁、没轮到的门禁和缺档/结局的 Gate ① 批准，门禁步骤不能用 `set` 改。

**回退（reopen）**：任何证据推翻了已完成的步骤——手测失败、复核判"未修复"、CI 确认由改动
引起、评审意见要改代码、基线前进要 rebase、熔断、结局或档变化——都用 `reopen <step>`：
该步及其后所有步骤回到 `pending`，被回退的门禁进入新一轮（上一轮的答复与迟到的 HIL 表单
提交都不再算数）。重跑被回退的步骤时先检查已有产物：属于本 run 且仍有效的（worktree、
基线日志、仍然失败的红灯测试）复核后直接 `done` 并在 `--note` 写明复用；外向产物（远端
分支、MR/PR、报告文档、tracker 记录）一律**原地更新**，绝不新建第二份——运行状态保留了
它们的 artifacts。

门禁答案带派生 id `gate:<sha256(runId|gate[|round])>`——重入的 run 找到本轮已记录的答案
而不是再问一遍；换了 runId 或进入新一轮才重新提问。

**规范步骤表**——`<step>` 只用这些 id，顺序即恢复顺序：

| # | id | 标签 | 不适用的情况 |
|---|---|---|---|
| 1 | `intake` | 取证 | — |
| 2 | `triage` | 分诊定档 | — |
| 3 | `reproduce` | 复现 | — |
| 4 | `locate` | 定位 | — |
| 5 | `gate1` | 🚦方案 | — |
| 6 | `worktree` | 隔离 | 结局非 `fixed` |
| 7 | `baseline` | 基线 | 结局非 `fixed` |
| 8 | `red` | 红灯 | 结局非 `fixed` |
| 9 | `fix` | 改码 | 结局非 `fixed` |
| 10 | `verify` | 验证 | 结局非 `fixed` |
| 11 | `evidence` | 证据 | 结局非 `fixed` |
| 12 | `e2e` | E2E | 结局非 `fixed` |
| 13 | `review` | 复核 | 结局非 `fixed` |
| 14 | `commit` | 提交 | 结局非 `fixed` |
| 15 | `gate2` | 🚦手测+MR | 结局非 `fixed` |
| 16 | `publish` | 推送+MR | 结局非 `fixed`；Gate ② 答复 `keep-local` |
| 17 | `ci` | CI | 同上；没有可查询的 CI（仓库无 CI，或 `forge=git` 且没有仓库 CI 查询工具） |
| 18 | `report` | 报告 | 结局 `abandoned` |
| 19 | `gate3` | 🚦回写 | `direct-evidence` |
| 20 | `writeback` | 回写+通知 | `direct-evidence`；Gate ③ 答复 `declined` |
| 21 | `audit` | 完成审计 | — |

## 输入分流——任何工具调用之前先定

从当前用户回合里选且只选一个模式：

- **`tracker-record`**：用户给了 tracker 记录选择器/链接、跑了 `/fix-issue`、或明确要求
  从 tracker 拉取/选择一条问题。解析、读取、认领，之后回写该记录。要求
  `tracker.type != none`。
- **`direct-evidence`**：用户给了问题描述加可用证据，如**用户提供的截图**、错误文本、
  堆栈、runId/logid、复现步骤，且没要求拉 tracker。把这些输入当作权威问题源。**不要调用
  `tracker.mjs`、列记录、要 record id、认领记录、下载附件或回写 tracker。**
  模块、优先级、提出人这类缺失的 tracker 字段是可选项；从证据和仓库上下文推断代码区域，
  只有歧义阻塞定位时才问。
- `tracker.type=none` 时 `tracker-record` 不可用：说明配置缺口并把输入按
  `direct-evidence` 处理（报告/回写/卡片自动 not-applicable）。

输入匹配内置路径时委派出去，不进本流水线（完整分流表归 `input-dispatch` §0）：

- **工单/工作项**（外部工作项系统的 URL 或 ID，无 tracker 选择器）→ 调用
  `workitem-quick-fix` 并端到端跟随它；它拥有 worktree 搭建、测试/E2E 保界和交接。
  不要为它跑 tracker 查询或本流水线门禁。工作项按档判定为 L 时改走 `input-dispatch`
  §1→5，XL 时走 `tech-proposal`（与 `workitem-quick-fix` 的判档规则一致）。
- **未验证的论断**（"看看这个是不是问题"、review 评论、二手 bug 转述、性能声明）→ 先调用
  `claim-verify-first`。证实的问题带着判定作为证据以 `direct-evidence` 回到这里；被证伪的
  以反证结束，不做编辑。
- **独立工具命令**（`/tech-proposal`、`/tracking-doc`、`/cuj-mindmap`、`/ci-report`、
  `/review-fix` 及原型/清理类工具）→ 直达对应 skill；它们是自包含工作流，绝不触发
  本流水线的三道交付门禁。
- **其他一切**（CI 事故、任务 URL、MR 续作/rebase、纯分析）→ 按 `input-dispatch`
  §0 分流；本修复流水线不拥有这些输入。

`[issue-fixer:direct-evidence]` 标记是显式的 `direct-evidence` 决定。不要仅因本
skill 也支持 tracker 就推翻它。一条输入里有多个根因不同的问题时，本流水线仍然接手，
在第 2 步按结局 `split` 拆分。

## 硬规则

- **只用适用的门禁**（其余全自动跑）。两种模式都用定位门禁 ① 和 MR 前门禁 ②。只有
  `tracker-record` 用回写门禁 ③；`direct-evidence` 没有东西可回写，不许造出第三个门禁。
- **Scratch 护栏**：`FIXER_TARGET != real` 时，绝不改生产 tracker，绝不 @/私信真实提出人。
  `config.mjs` 的 `assertTrackerWritable` 替你强制这一点；保持它生效。
- 每个定位断言都引 `file:line`。代码改动保持外科手术式。
- 行号只是选择器，永远不是问题语义。建分支或编辑前，确认**问题指纹**。`tracker-record`
  包含解析出的 `recordId`、问题描述、模块、优先级、原始截图（或其确切不可用原因）。
  `direct-evidence` 包含 source=`direct`、用户原文描述、所供证据、以及明确标注为推断的
  区域/优先级。指纹由 `runstate.mjs fingerprint` 计算，同一指纹贯穿 E2E 交接与报告。
- **根因优先**：Gate ① 必须给出因果链（触发 → 代码路径 → 错误状态 → 症状）。只压住症状
  的改动（吞异常、兜底默认值、放宽校验、加重试/延时）必须标 `fixKind=mitigation` 或
  `workaround` 并单独批准，绝不说成根因修复。方法见 [references/diagnosis.md](references/diagnosis.md)。
- **先红灯再修**：编辑产品代码前，让问题在 `$BASE` 上以可观察的方式失败（回归测试、
  `before` 截图/实测属性、脚本化复现或性能基线），修复以同一检查转绿为准。
- **结局可以不是"修复"**：已修复、无法复现、符合设计、重复、外部根因、待决策都是正当
  结局，按 [references/outcomes.md](references/outcomes.md) 交调查报告；不为了"有产出"硬改代码。
- **熔断**：失败假设数达到档预算、定位两轮达不到 medium、Gate ② 手测连续两次失败——停
  手、留现场、带假设日志回 Gate ①（[references/sizing.md](references/sizing.md)）。
- **升档即回 Gate ①**：命中任何升档触发（方案外文件、越过档上限、风险域、改已有测试断言、
  新依赖）先回 Gate ①，再继续。
- 任何下游步骤宣称成功前先跑能力与仓库 preflight。
- **模拟证据优先**：UI 修复用确定性组件 fixture 产出标注清楚的模拟 Before/After。默认
  截图不做认证探测、不发现/部署环境、不起完整产品栈。fixture 无法呈现所报状态或需要活体
  检查时，用 `before-after-capture` 的 **`local-dev`** 通道——worktree 上一个常驻 dev
  server 连远程后端——绝不做环境发现/部署。真实环境证据是单独的可选后续，不得阻塞
  主流程完成。
- **用户输入能解锁时就主动问。** 不要只报"缺环境""权限被拒""认证卡住"。立即问出所需的
  最小具体输入或动作（例如：仓库路径、目标路由、环境名、浏览器登录、scope 授权、原始
  截图），说明怎么提供，并说明之后从哪一步恢复。一次只问一个聚焦问题。
- **门禁卡片固定结构**：三个门禁的展示内容与选项按 [references/gates.md](references/gates.md)，
  先展示完整卡片再提问；沉默不等于批准。
- **部署态门禁走 HIL 表单**。在 connector 运行时里，门禁用
  `notify.mjs` 的 `publishGateFormViaConnector` 发 `hil_form_schema` 卡片——
  `requestId` 与选项取 `runstate.mjs gate-id <runDir> <gate>`（按当前轮次派生；回传落盘时带
  `--request-id`，上一轮表单的迟到答复会被拒绝），submit/cancel 都以
  `plugin_event_publish` 事件回到本插件（`issue-fixer.gate.decided`），答案落进
  run-state 里同一个派生 id 下。本地 lark-cli 路径没有回调面，门禁仍走原生提问。

## 进度披露（框架原生）

跑步骤时，**以 assistant 文本发出进度清单**。每次步骤转换后，先用 `runstate.mjs set`
落盘，再跑 `node <root>/scripts/lib/runstate.mjs progress <runDir>` 生成
` ```fixer:progress` 标记块，把它带进你叙述的回复——部署态运行时的 turn 流式事件会把它
随文本同步到消息桥，本地则是一段可读清单。块由运行状态按规范步骤表生成，状态词自动折成
桥的词表（`not-applicable`→`skipped`、`failed`→`error`），blocked 步骤附带 waitingFor。

运行状态还没建（第 1 步之前）时用 `node <root>/scripts/progress.mjs "<标签:状态,…>" "修复 <issue_id>"`
手写，标签取规范步骤表。

真实环境不是主流程步骤，不进进度清单：真实环境在主流程中始终 `skipped`，即使早就拿到了
lane；把该 lane 排进完成后的后续。无可观察界面的非 UI 问题，`evidence` 步骤产出行为验证
说明而不是截图。`direct-evidence` 的回写两步自动为 `not-applicable`。

助手生成这个 fenced 块，但它的 Bash/工具 stdout **不是** assistant 文本流的一部分。
把生成的块原样拷进 assistant 文本；不要只跑命令。每次转换都发（刚完成的步骤 → `done`，
下一个 → `running`）。

## 流程

每一步以**完成判据**收尾：判据没满足就不是 `done`，不进入下一步。

### 1. `intake` · 取证、指纹、运行状态

**`tracker-record`：先 preflight 数据访问，再 解析 + 读取 + 认领。** 先跑
`node <root>/scripts/lib/tracker.mjs preflight`——`lark-base` 下它一次检查 lark-cli
二进制 + 登录态（whoami）+ 必需的表配置，并返回操作者 open_id；`ok:false` 时按
`kind`（missing_bin/unauthenticated/config）摆出确切解锁动作，不要往后续步骤里带病走。
参数可能是 `record_id`、`#N`（表视图第 N 行）或 `<openStatus>#N`。解析它：
`node <root>/scripts/lib/tracker.mjs resolve "<selector>"` → `recordId`
（或直接 `tracker.mjs get "<selector>"`，也接受选择器）。然后提取 问题描述、
模块、优先级、提出人(id+name)、问题截图（字段名都由 `tracker.fields` 配置）。
把状态→`status.claimed` 作为认领（`tracker.mjs claim <record_id>`，带 scratch
护栏；scratch 模式下打向配置的 scratch 表，未配置则拒绝写——这是预期）。幂等：
若状态已是 claimed/done/fixed，停下并报告。提出人身份用 `tracker.reporterOf(record)`
解析（user 单元格 → open_id/name），不要手抠单元格形状；scratch 模式的 `notifyOpenId`
用 preflight 返回的操作者 open_id，不需要手动配置。

还没有 scratch 表时，一条命令建出来：`node <root>/scripts/lib/tracker.mjs init-scratch`
——它用 `lark-cli base +base-create` 按 `tracker.fields` 语义建好带完整字段的表，返回
`{baseToken, tableId}` 和可直接粘进 `fixer.config.json` 的 `configSnippet`。

把 `[]` 当"无记录"之前，要求成功的 API envelope，并独立拉取表/视图元数据或解析出的记录。
若 API 报 scope/权限/认证错误，把它摆出来；绝不转成空列表。记录是哪个身份/工具供的数据。
允许用更宽凭据做只读兜底，但要标注其来源且不复用于写。记录和截图都读不到时到此为止。

在 `tracker-record` 中经 `tracker.mjs download` 下载问题截图。私有附件 URL 不是图片已读
的证据。403/scope 失败时保留确切错误并把截图标记为不可用。解读图像前先展示解析出的记录
指纹。

**`direct-evidence`：接受当前回合作为输入。** 不执行上面的 tracker 段。逐字保留用户描述
并检查每个提供的图片/文本产物。用一个简短问题 slug 给分支/产物名建稳定的本地 `issueId`
（实在没有稳定 slug 才退到时间戳）。记 `source=direct`；tracker 身份、访问、认领、附件
下载全部是 `not-applicable`，不是失败。直接用当前回合的文本与图片输入，不做任何 tracker
兜底。所供证据确实不足以指认症状时，问一个聚焦问题；绝不只因没有 tracker 选择器就去要一个。

**两种模式共同：**

- 记录描述或用户输入里的飞书链接不是"读过"——先取回再引用：跑
  `node <root>/scripts/evidence.mjs collect --record-file <record.json> --out <runDir>/evidence`
  （direct-evidence 用 `--text "<输入>"`）。它把 docx/wiki 拉成 markdown、minutes 拉摘要+
  逐字稿、`om_` 消息连同图片附件一起下载；sheets/file 链会标 `manual` 由你补抓。清单落在
  `evidence-manifest.json`——`failed` 的链接摆出来，不要假装读过。
- 描述与截图不足或矛盾时，问而不是按行位猜测。只要缺的证据是用户能提供的，现在就主动要：
  请用户上传原始截图、确认解析出的记录描述、或指认目标元素。不要带着猜测继续等。
- 算指纹并建运行状态：`runstate.mjs fingerprint …`（`tracker-record` 带 `--record-id`、
  `--module`、`--priority`，截图用 `--evidence`）→ `runstate.mjs init <runDir> --run-id
  <issueId> --mode <mode> --fingerprint <fp>`。`<runDir>` 默认是
  `<artifactsDir>/<issueId>`；把 issueId 与 runDir 写进第一次进度披露，上下文丢失后用
  `runstate.mjs list` 找回。`<runDir>/run-state.json` 已存在时这是一次续作：`runstate.mjs
  show`，核对指纹一致后从恢复点继续；`init` 以不同模式或指纹重入会被拒绝——说明问题变了，
  问用户是开新 run 还是更新本 run。

**完成判据**：指纹已算出并展示；运行状态已建（或已恢复）；每条证据要么已读（附本地路径），
要么有确切的不可用原因；用户能补的缺口已经问出。

### 2. `triage` · 分诊定档

先分类——**不是每条记录都是 UI 修复**：

- **UI / 视觉 / 交互**（布局·尺寸·样式·文案·错位·间距·颜色）→ `ui`，第 4 步调
  **ui-issue-localize**（截图→组件）。before/after = 截图。
- **报错 / 崩溃 / 白屏 / 接口**（stack trace、500/4xx、"点击无反应"、"报错"、runId/logid/
  白屏）→ `runtime-error` 或 `backend`，用仓库的日志/排障工具做日志驱动定位，**不**用截图。
  "before/after" 变成 复现→修复行为说明（有可见界面时才附截图）。
- **数据错误**（值不对、重复、丢失）→ `data`；**慢/卡/包体大** → `performance`；
  **开关/配置/环境取值** → `config`；**注入/越权/泄露** → `security`（最小披露规则见
  [references/situations.md](references/situations.md)）。
- **不确定 / 描述过短 / 无截图** → `unknown`：动代码前先问（本地 AskUserQuestion；部署模式下
  运行时的原生提问卡片）——不要猜。

证据里的结构化输入先走对应解析器而不是手抠：工单 URL/ID → 配置的工作项抓取
（`workitemFetchCommand`）或对应 skill；跨仓定位或"这功能在哪个仓库实现" → 仓库的
代码搜索工具。解析失败保留确切错误，不要凭链接样式猜内容。

然后：

- **初定档**：按 [references/sizing.md](references/sizing.md) 的判档表凭证据与仓库结构估，
  `runstate.mjs meta --classification <c> --tier <t> --reason "<命中信号>（preliminary）"`。
  同时给出严重度（`--severity sev1..sev4 --severity-source inferred|reported`；sev1 阻断 …
  sev4 轻微，与档无关）。
- **拆分检查**：输入含多个根因不同的问题 → 结局候选 `split`（situations.md"一条输入里有
  多个问题"）。
- **重复/并行检查**：查同一 issueId 的 worktree/分支、提到同一记录或同一文件的开放 MR/PR
  （situations.md"已有人在修 / 重复"）。

**完成判据**：分类、初档（附命中信号）、推断严重度已写进运行状态；拆分与重复检查都有结论；
分类为 `unknown` 时本步保持 `blocked` 直到用户回答。

### 3. `reproduce` · 复现

在当前基线上看到症状，方法与记录格式见 [references/diagnosis.md](references/diagnosis.md)
§1。本步不改任何产品代码：查日志、读已有数据、对远程后端发请求、跑已有测试。需要运行
`origin/<base>` 的代码时（跑测试、起 local-dev、`already-fixed` 的确认、bisect），建一个
**探针 worktree**：`git -C <FIXER_REPO_DIR> fetch origin <base>` 后
`git -C <FIXER_REPO_DIR> worktree add --detach <runDir>/probe origin/<base>`——detached、
无分支、只在 `<runDir>` 里，只为复现装依赖；Gate ① 之前"不建分支、不编辑"对它同样成立。
主 checkout 可能停在别的分支上，不用它判断"最新基线是否正常"。在探针上起的 dev server
（`devserver.mjs start <runDir> --cwd <runDir>/probe`）不会被修复 worktree 复用——
`devserver.mjs start` 发现 cwd 不同会停掉旧的再起新的；仍建议在第 6 步 `stop` 它。UI 问题的用户原始截图就是
症状证据；静态证据不够时第 4 步的动态确认（可 serve 探针 worktree）兼作复现。

`not-reproduced` 时做 IS / IS NOT 表，按差异最大的维度再试一次；仍不复现就是结局候选
`already-fixed`（最新基线行为正确，找修复提交）或 `cannot-reproduce`（问提出人那一个维度），
在 Gate ① 决定。间歇性问题记失败率（重复 N 次）。

**完成判据**：`<runDir>/repro.json` 写好，`status` 为 `reproduced | not-reproduced |
not-attempted` 之一，带方法、环境、逐字观察；`not-reproduced` 附 IS / IS NOT 表；
`not-attempted` 附卡住的原因与已问出的问题。

### 4. `locate` · 定位与根因

- `ui` → 调 **ui-issue-localize**。其余分类 → 按 [references/diagnosis.md](references/diagnosis.md)
  §2 分层定位（区域 → 文件 → 符号 → 行），报错/后端/数据走日志驱动。
- 写因果链（diagnosis.md §3）；M/L 档加"为什么现在"——回归时找引入提交，可独立回退时把
  "回退 vs 前向修复"作为两个选项。
- 过一遍症状修复自检，定 `fixKind`。
- M/L 档列影响面（改动符号的调用方/使用页面）并做同类缺陷扫描（diagnosis.md §4）；
  同类命中进 `followUps`。
- 按已定下的具体方案重算档（正式档），命中风险域直升。L 档用 `tech-proposal`（轻量/标准）
  产出方案文档随 Gate ① 呈现：文档写在 `<runDir>` 并经 report 适配器发布，Gate ① 之前不写进
  目标仓库；仓库惯例要求设计文档入库时，批准后在修复 worktree 里作为 diff 的一部分提交。
  `tech-proposal` 自己的大纲确认、发布位置问题在本步内按其流程问。仓库惯例要求 L 档方案
  先经团队评审（RFC/设计评审），或用户在 Gate ① 要求先评审时，结局为 `escalated`。XL 档
  不在本流水线修——结局 `escalated`，并把可先做的最小切片作为 Gate ① 卡片里的备选方案。

返回候选 `file:line`、复现路由/步骤、建议的最小改动、耦合值、红灯检查计划。

定位已确认但**最小改动方案本身需要探索**（多种合理交互形态、状态模型/流转拿不准、
靠读码无法判断哪种行为对）时，先调 **`prototype`** 做一次性打样验证，把结论连同定位
一起带进 Gate ①。原型是一次性产物：写在 worktree 里跑给用户看可以，但不 stage、不进
交付 diff、不算验证证据。哪种行为对是产品/设计决定时，结局候选 `needs-decision`。

置信度规则沿用 `ui-issue-localize`：`high`/`medium` 进 Gate ①（`medium` 披露还没验证什么）；
`low` 返回候选 + 一个聚焦问题。两轮收窄仍到不了 `medium` 就停下问。

**完成判据**：`file:line` + 两个独立锚点 + 置信度 `high`/`medium`（或无改动结局的证据齐备）；
因果链每一环有出处；正式档与结局提议已定；M/L 档影响面清单完成。

### 5. 🚦 GATE ①

按 [references/gates.md](references/gates.md) 的 Gate ① 卡片展示：指纹（含已知的模块/
优先级）、五个坐标、复现、根因、定位、结局提议、方案、影响面、风险与回滚、可见界面。`classification=ui` 或其他可见
界面时，同时定下后面截图要用的精确绝对 **product entry URL**（`capture.productEntryUrl`
或当场确认）和**目标路由**。等待批准。被拒就在定位上迭代。**此门禁之前不建分支、不编辑、
不截 "after"、不推送、不开 MR。**

展示卡片**之前**先用 `meta` 写入提议的正式档、结局、`fixKind`、改动面、路由与
`productEntryUrl`；卡片里的值就是运行状态里的值。答复用 `runstate.mjs gate <runDir> gate1
<approved|changes-requested|need-info|abandon> --summary "<用户原话>"` 落盘：
`changes-requested`（改方案、重新定位、或选 XL 的某个切片）自动回退到 `locate`；`abandon`
把结局记为 `abandoned`。部署态 HIL 表单的 `requestId` 取 `runstate.mjs gate-id <runDir> gate1`。
之后任一发生实质变化（不同组件、路由或行为、结局、升档），`reopen` 后回到 gate ①。已批
方案内的行号移动或实现细节不需要再过一次门禁。

批准的结局不是 `fixed` 时，第 6–17 步自动变 `not-applicable`，直接到第 18 步出调查报告
（`abandoned` 不出报告，`tracker-record` 仍到 Gate ③ 释放认领）。

**完成判据**：gate1 已记 `approved`，summary 含批准时的指纹、结局、档与方案要点。

### 6. `worktree` · 隔离

绝不编辑用户主 checkout。按 `worktree-flow` §1–2（其完成判据适用）从新 fetch 的远程基线建
同级 worktree：

> **`worktree.mode=in-place`（可选，磁盘紧张时）**：不开 worktree，直接在主 checkout
> 的对应分支上改。先 `git -C <repo> status --porcelain` 摆出工作区现状——有未提交改动
> 时逐条问清归属，绝不 stash/还原别人的改动；`worktree.inPlaceBranch` 非空时
> `git switch <branch>`（冲突即停），为空就留在当前分支；`BASE` 仍取刚 fetch 的
> `origin/<base>`，若当前分支落后于它先说明再动手。运行状态记
> `meta --isolation in-place --start-branch <起始分支>`（`mode` 是来源模式，不要覆盖）；后续所有写、验证、提交都以主 checkout 为 cwd。worktree-flow 的隔离判据中
> "不污染主 checkout" 降级为 "不污染共享工作区里别人的改动"——其余照旧。

- `git -C <FIXER_REPO_DIR> fetch origin <base>`，`<base>` = `FIXER_BASE_BRANCH`（热修复
  时为用户指定的发布分支，`meta --base-branch` 记录，见 situations.md）；
  `BASE=$(git -C <FIXER_REPO_DIR> rev-parse origin/<base>)`。基线是 fetch 到的远程
  SHA，不是本地分支头。
- `git -C <FIXER_REPO_DIR> worktree add <worktreePath> -b fix/agent-<issue_id> $BASE`
  ——`worktreePath` 来自 `worktree.dirTemplate`（默认 `{repoParent}/{repoName}-fix-<issueId>`），
  分支前缀来自 `worktree.branchPrefix`。`tracker-record` 中 `issue_id` 是 record id，
  `direct-evidence` 中是稳定的本地 id。worktree 或分支已存在时先检查：明确属于本问题
  才复用，否则选唯一 slug；绝不删除或覆盖。
- 在 worktree 内验证：`rev-parse --show-toplevel` 解析到那里、`branch --show-current`
  是修复分支、`rev-parse HEAD` == $BASE。然后在 worktree 内跑配置的 install 命令
  （`verify.install`，如 `pnpm install`——主 checkout 的 post-merge hook 不覆盖新
  worktree）；若生成产物或跨包 dist 仍缺失，按仓库文档的就绪度补齐。
- 之后所有写、验证、E2E、提交命令都以 worktree 为显式工作目录。`FIXER_REPO_DIR` 继续指向
  主 checkout 供 `capture.mjs` 二进制解析；自带脚本要仓库路径时（如
  `result.mjs snapshot`）传 worktree。
- 续作已有 worktree，或基线过期需要 rebase/处理冲突 → `branch-sync` §1–4；
  其冲突确认契约原样适用。
- 主 checkout 有未提交改动且与已批修复重叠时，先问哪些改动属于本问题，再往 worktree 搬。

**完成判据**：`git -C <wt> rev-parse HEAD` == $BASE；分支是预期的修复分支；主 checkout 的
`git status` 与动手前一致；依赖已装；`runstate.mjs meta --base-sha $BASE --worktree <wt>
--branch <b>` 已记录。

### 7. `baseline` · 基线

编辑前在 worktree 内 preflight：

- 检查包管理器配置、`NODE_ENV`、workspace link、lockfile、patched 依赖。
  lint/typecheck/test 需要时显式安装 devDependencies；不要让 `NODE_ENV=production`
  静默丢掉工具链二进制。
- 优先仓库锁定安装。若因 lockfile 与 patch 元数据不一致失败，报告该不一致并用仓库文档的
  恢复方式；不要作为无关修复的一部分静默规范化或重写 lockfile。
- 在未动的基线上跑一遍相关 lint/typecheck（M/L 档加受影响包的测试集）并留存输出。
- 缺 lint/typecheck 二进制是 preflight 失败，不是豁免验证的许可。恢复锁定的
  devDependencies，或跑仓库支持的 CI 等价命令。仍不可行就把验证标 `blocked`；绝不用
  "纯 CSS，低风险"顶替。

然后编辑前记录对比点 SHA（$BASE）。

**完成判据**：基线 lint/typecheck（及所选档位的测试）输出存进 `<runDir>/baseline/`；既有
失败逐条列出（它们之后单列，不算本次引入）。

### 8. `red` · 红灯

产品代码还在 $BASE 时，让问题以可观察的方式失败（[references/diagnosis.md](references/diagnosis.md)
§5，深度按档）：

- `classification=ui` 时趁树还在 $BASE 现在就截基线 `before` 产物（走
  `before-after-capture` 的所选通道），并实测变化属性——第二个干净 worktree 只是编辑后
  恢复的兜底。
- 逻辑/报错/数据：归属层有测试 harness 时写回归测试（所有档），在 $BASE 上跑，失败信息
  必须就是所报症状；没有 harness 时用脚本化复现 `<runDir>/repro.sh`，M/L 档要在 Gate ②
  卡片里说明为什么没有回归测试。
- 性能：基线实测（指标、方法、样本量）。
- 回归测试属于修复的一部分，进交付 diff；复现脚本与采样脚本留在 `<runDir>`。

**完成判据**：红灯检查在未改产品代码的 worktree 上失败，且失败原因与所报症状对得上
（输出存 `<runDir>/red.txt`）；UI 的 `before` 产物已存在；确实无法建立红灯时有书面理由
并已写进 Gate ② 卡片的限制项。

### 9. `fix` · 改码

做外科手术式编辑。复查定位 skill 标出的耦合布局值。每轮"假设 → 改动 → 验证"都记进
`<runDir>/hypotheses.md`；失败假设数达到档预算就熔断回 Gate ①（sizing.md）。

- `config.repoRules` 注入的仓库硬规则在此生效——测试落位、i18n 接线、changeset/发布约定、
  staging 纪律都按它的字面执行，缺哪条补哪条，不拿"通用流程"当豁免。
- 测试代码保界按 `workitem-quick-fix`：仍覆盖契约的通过测试/E2E 不动；预期行为变化迫使
  测试调整时，证明因果并保持最小——改已有断言是升档触发，先回 Gate ①。
- 发现相邻问题、想顺手重构或统一格式 → 写进 `followUps`，不进本次 diff。

**完成判据**：红灯检查转绿；`git status` 里每个文件都能指认对应验收点；diff 中无方案外
改动；假设日志完整。

### 10. `verify` · 验证

所有命令在 worktree 内跑。深度按 `repo-collab` 验证分级——纯样式/文案 → lint + 视觉证据；
逻辑/缺陷 → 最窄归属层测试 + 受影响包 build；用户可见或协议变化 → 下面的 E2E 阶段；
性能 → 实测前后数据。档再叠加：M 档加受影响包完整测试，L 档加仓库 CI 等价的全量检查
（可行时）。各档命令优先取 `verify.lint`/`verify.typecheck`/`verify.test` 配置，未配置时按
`worktree-flow` 的 `references/verify-matrix.md` 从仓库工具链推断；watch 模式的 test runner
永远带显式 run 参数（裸 `vitest` 是 watch 会挂起）。

UI/可见界面问题，确认目标路由能加载——已有 `local-dev` server 在跑就复用；不要仅为这个
检查单起 server。dev server 和浏览器会话在 修复→验证→截图 循环中保持温热，只在依赖/
环境变化时重启。无路由的非 UI 问题，用留存的复现作为定向行为检查。结果与留存的基线对比：
既有的工作区/构建错误必须单列，改动文件里的任何新错误是阻塞项。"原来过的仍然过"：基线
通过的受影响测试修复后仍须通过。

**完成判据**：门槛 = 无新 lint/类型错误 + 定向行为检查 + 适用的路由加载；绝不把全红基线
描述成"pass"。每条命令都实际执行且输出留存。

### 11. `evidence` · 证据：模拟 Before/After 截图（默认）或行为验证说明

调 **before-after-capture** 的默认 `simulated-component` 模式——记录的改动前 commit 是
$BASE，其 `before` 产物已在第 8 步编辑前截好；干净基线 worktree 只是编辑后恢复的兜底。
在确定性 fixture 中渲染定位到的组件，基线与改后修订用同样的 props、视口、主题、数据、
交互状态。产出 `before.png`、`after.png`、`compare.html`、`conversationMarkdown`。图片与
报告标注为模拟组件证据；绝不当作真实产品页。

这步就是捷径：不做认证探测、不找环境、不部署、不起完整产品栈、不试产品域变体。
用户原始截图是视觉参考，不是基线产物。fixture 无法呈现所报状态时，先切 `local-dev` 通道
——worktree 上一个常驻 dev server 连远程后端（`capture.devServerCommand`）——再考虑记为
限制；`local-dev` 截图是活体路由证据，仍不是部署环境证据。

本截图步骤只适用于 `classification=ui` 或其他确认的可见界面。无可见界面的非 UI 问题，
把截图产物标 `not-applicable`，保留复现 + 修复行为作为行为验证说明（写明复现方法、红灯
输出、修复后同一检查的输出）。

常驻 dev server 的启停走 `node <root>/scripts/devserver.mjs start|status|stop <runDir>`
——它写 `<runDir>/dev-server.json` pidfile，复用已存活的实例，run 结束必须 `stop`；
下个会话的 SessionStart 会 sweep 掉漏回收的。

有状态的视觉改动（hover/focus/展开/收起/加载中），在该 skill 定义的状态矩阵上对两个修订
都截。一张修复后截图或两个修复后交互状态不是 before/after 对比。

截图成功时，把返回的 `conversationMarkdown` 原样渲染进会话正文和最终回答。
**before-after-capture** 是唯一呈现契约；不要重建或替换成第二种格式。报告与通知是独立的
交付产物。

**完成判据**：UI——对比满足 before-after-capture 的接受条件，`conversationMarkdown` 已渲染进
正文；非 UI——行为验证说明写好并存进 `<runDir>`。

### 12. E2E 覆盖检查（`e2e`）

调 **e2e-check**，带记录的 $BASE 对比点 SHA、worktree 真实产品 diff
（含 index 与工作区）、问题指纹、定位路由/复现、可见状态、`mode=composed`、`issueId`、
`fingerprint`、输出路径 `<runDir>/e2e-result.json`。快照、路径推导、覆盖审计、E2E harness
选择、测试实现、验证、原子持久化都归那个插件。

只消费持久化结果。先跑新的 `result.mjs snapshot <worktree> <comparison-point>`，
再 `result.mjs read <runDir>/e2e-result.json --mode composed --issue-id <issueId> --fingerprint <fingerprint>
--diff-hash <fresh-diffHash>`。把回执字段（`resultPath`、`schemaVersion`、`sha256`、
`diffHash`、`issueId`、`fingerprint`）存进运行状态。issueId、fingerprint 或 diffHash
不匹配是过期交接，不是可复用的部分结果：重新调 **e2e-check**。只有 `status=completed` 才
继续；`blocked` 时问 E2E 插件记录的那个聚焦问题，并恢复该插件而不重启已完成的
orchestrator 步骤。`read` 响应同时含完整校验结果与回执字段；直接消费其记录的 blocker，
不要从回执重建问题。

**完成判据**：`result.mjs read` 以当前 diffHash 校验通过、`status=completed`，回执已存进
运行状态（`set <runDir> e2e done --artifact e2eResult=<path>`）。

### 13. `review` · 复核

在最终 diff（含 E2E 新增的 spec）上复核"这份改动是否真的解决了所报问题"：

- **所有档：自查清单**逐条写结果——因果链每一环在 diff 里有对应改动；无方案外文件；无调试
  残留、注释掉的代码、临时日志；回归测试断言的是所报症状；耦合值已同步；`repoRules`
  逐条满足；没有打印或提交凭据。仓库自己的 review 能力可发现时，拿报告的问题与验收点复查
  当前 diff 是否真的解决它（S/M 有则用，L 必用）。
- **M/L 档：独立复核**——另调 **bugfix-review**，子代理只拿问题描述（原文 + 复现）、待审
  diff（`$BASE...HEAD` 加工作区）与其评审规则，不带你的诊断与预期结论。

裁决 `从代码看未修复` → `reopen fix`，计一个失败假设。`暂无法确认是否修复` → 补齐缺的证据
（加测试、补复现）后重审，或把缺口原样写进 Gate ② 卡片。复核后任何代码、fixture、测试
编辑都使 E2E 交接失效，`reopen e2e`。

**完成判据**：自查清单每一条都有结果，或 bugfix-review 的裁决与关键依据已记录（`set <runDir>
review done --note "<裁决>"`）；裁决为"从代码看已修复"，或"暂无法确认"且缺口已写明。

### 14. `commit` · 提交

在 **worktree 内**用仓库自己的提交约定（Conventional Commit、scope = 真实包名/模块名；
部署态配置允许时加 `Co-Authored-By`）；仓库有 changeset/changelog 约定时一并生成。只 stage
映射到验收点的文件——先 `git status`，确认无无关文件才 `git add -A`。本步只提交，**不推送**：
推送是 Gate ② 批准后的外向动作。

**完成判据**：`git status` 干净（或剩余文件都能说明不属于本修复）；`git log $BASE..HEAD`
只含本修复的提交；提交信息符合仓库约定。

### 15. 🚦 GATE ②——用户测试结果，然后 MR

**前置检查**（按顺序，全部通过才展示卡片）：

1. **基线新鲜度**：`git -C <FIXER_REPO_DIR> fetch origin <base>`；`origin/<base>` 已前进时
   按 situations.md"基线在运行中前进了"处理——需要 rebase 时 `branch-sync` rebase 后
   `meta --base-sha <新基线>` 并 `reopen red`：红灯在新基线上重新确认、UI 的 `before` 在新基线
   重截，其后的验证、证据、E2E、复核、提交与本门禁依次重走。
2. **E2E 交接仍有效**：再对仓库做一次快照并用指纹和当前 diffHash 重读 `e2e-result.json`。
   E2E 之后的任何代码、fixture、测试编辑都使交接失效并回到第 12 步。
3. **复核已记录**：第 13 步 `done`。

按 [references/gates.md](references/gates.md) 的 Gate ② 卡片展示 diff 摘要、分支、红灯→绿灯、
验证、证据、E2E 决策/结果、复核裁决，复述 **e2e-check** 已发出的确切 `manualTestPrompt`，
并写明批准后将执行的推送与 MR。请用户回报 `passed`、首个失败步骤加证据、具体环境
blocker、或显式 deferred 手动测试。这仍是既有的 MR 前门禁：用户显式批准建 MR 时允许
defer 手动测试。用户发现失败就回到适用的修复与截图步骤，再重做验证、E2E、复核、提交和
本门禁，让 MR 不指向过时代码；连续两次失败回 Gate ①。受影响路径变化时重新生成提示。

Gate ① 的已批方案加 gate ② 的批准是本流水线的显式推送授权；推送只发生在 gate ② 批准
之后（或用户在本门禁选择"只推分支供预览测试"时），且只覆盖卡片里展示过的那份 diff。
推送之后再有任何代码改动（CI 修复、评审意见、手测失败后的修复），都经 `reopen` 重新走到
本门禁，卡片展示相对上次推送的增量，批准后再推。流水线外的推送仍要 `repo-collab`
的逐指令授权。

答复落盘：`approved`（手测通过）、`approved-deferred`（显式 deferred）、`failed`（自动
`reopen fix`，summary 写首个失败步骤 + 证据）、`push-only`（只推分支供预览测试，门禁保持
`blocked` 等预览结果）、`keep-local`（留在本地，`publish`/`ci` 随之不适用）。环境 blocker：
`meta --manual-test blocked --manual-evidence "<blocker>"`，再问用户 deferred 继续还是等环境。

**完成判据**：gate2 以 `approved`、`approved-deferred` 或 `keep-local` 关闭；手测结果
（`passed | deferred`）连同用户原话已在运行状态的 `manualTest` 里。

### 16. `publish` · 推送 + Draft MR

建 MR 前再对仓库做一次 `result.mjs snapshot` 并用指纹和当前 diffHash 重读
`e2e-result.json`（`push-only` 之后到建 MR 之间有任何变化都会在这里被发现，不匹配就
`reopen e2e`）。然后 `git push -u origin HEAD`（在 worktree 内）；本 run rebase 过的分支按
`repo-collab` 用 `git push --force-with-lease`，绝不用裸 `--force`。然后创建到 `FIXER_BASE_BRANCH`（或本 run 的
热修复基线）的 **Draft** MR/PR：**优先仓库的 MR 工具/插件**；不可发现时用脚本兜底
`node <root>/scripts/mr.mjs create --head fix/agent-<id> --base <FIXER_BASE_BRANCH>
--title <t> --body-file <body.md> --cwd <worktree> [--reviewers ...]`，走 `forge`
适配器（`git` 返回 deployPending、`github` 走 `gh`——自动从 origin remote 解析
owner/name、按 head 去重并更新已有 PR 的标题/正文、`custom` 走 `forge.mrCommand` 模板）。
填仓库的 MR 模板（Summary/Changes/Test Plan 或等价物），深度按档：M 档加根因与风险，
L 档再加回滚步骤与发布注意事项；回归写明 "Regression from <sha>"；安全类按最小披露。
`direct-evidence` 省略 reviewers，除非用户给了。返回 `deployPending`（forge 不可用/未配置）
时，摆出确切命令并继续（报告/回写仍进行，带 MR-pending 备注）。

**关联工作项**：tracker/工单来源的 MR 需要回填关联时，用 tracker/forge 提供的关联机制，
不在此处手写平台 API。

**完成判据**：远端分支 SHA 等于本地 HEAD；Draft MR/PR URL（或 `forge=git` 时如实的 pending
命令）已存进运行状态（`--artifact mr=<url 或 pending>`）；已存在的 MR 被更新而不是新建。

### 17. CI 跟进（`ci`）

MR 存在后，检查所有必需检查并在环境正常超时内等终态。`forge=github`
时用 `node <root>/scripts/mr.mjs checks --head <branch> --cwd <worktree>` 拿按
`pass/pending/fail` 分桶的检查列表与链接（`gh pr checks`），并附 `gh pr view` 得出的
一词状态 `status`（merged > closed > draft > ci_failed > changes_requested >
merge_conflict > ci_pending > mergeable > approved > review_pending > pr_open）——
`status` 直接回答"下一步该干嘛"；`--watch` 做有界等待（exit 0/1/2）。其他 forge 用仓库自己的
CI 工具。检查失败时：

1. 拉完整的失败 job 日志，记录 job/check 标识、attempt 号、失败断言、改动文件重叠度、
   同一失败在基线/默认分支是否已存在。仅凭路径不匹配不足以证明失败无关。
2. 分类为 `caused-by-change | pre-existing | flaky | infrastructure | unknown`，带证据。
   日志未拉全时保持 `unknown`。
3. `caused-by-change` 要修：`reopen fix`（计入假设预算），重走到 Gate ②，批准后推送更新
   同一个 MR。可信的 flaky/基础设施失败最多自动重跑一次，然后等并记录其
   终态。重跑成功是 flaky 的证据；仅接受重跑请求不是。
4. 重跑仍失败或换了错误，别再叫它无关，诊断它。

检查在跑时 CI 步骤保持 `running`；权限挡住检查/重跑时 `blocked`；确认由改动引起的失败
仍在时 `failed`。仓库没有 CI，或 `forge=git` 且没有仓库自己的 CI 查询工具时，
`set ci not-applicable --note "<哪种能力缺失>"`，报告里如实写"未经 CI"。独立的报告工作继续，但必需 CI 未了不得宣称交付完成。MR 评审意见处理走
仓库自己的评论/评审工具，每条意见按 situations.md"MR 创建后的评审意见"先验证再改。

**完成判据**：每个必需检查都到终态：通过，或失败已分类并带证据（`caused-by-change` 已修复
并重新到终态）。

### 18. `report` · 报告

用 `report-only` 模式调 **fix-report**，带完整模型（source、issue、tier、classification、
outcome、locate、rootCause、regressionOf、fixKind、plan、diff、redGreen、verify、review、
compare.html、E2E 交接回执、手动测试结果、MR/task 链接、followUps）。它构建 markdown 并经
`report` 适配器发布（`markdown` 落产物目录、`lark-docx` 发飞书文档、`custom` 走
`report.publishCommand`）；记下 URL。

结局不是 `fixed` 时同一调用出**调查报告**：`report.mjs build` 看到 `outcome != fixed` 改用
调查报告模板，并校验 `conclusion`、`investigation`、`evidence` 与该结局的必需证据
（outcomes.md 结局表）。

**完成判据**：发布返回确认的 URL/路径并存进运行状态。

### 19. 🚦 GATE ③（仅 `tracker-record`）

按 [references/gates.md](references/gates.md) 的 Gate ③ 卡片展示将写入的内容：状态值、备注
全文、跟进人、附件、通知接收人。`fixed` 结局默认状态为 `status.done`；无改动结局的状态值
由用户从配置的 `tracker.status` 取值（或"保持不变"）中选，不选就只写备注；`abandoned` 默认
把认领回滚到 `status.open`；`cannot-reproduce` 的备注与通知里带上要问提出人的那个问题。
答复落盘：`approved`、`writeback-only`（只回写不通知）、`changes-requested`、`declined`。

`direct-evidence` 跳过本步与下一步：没有记录或提出人可更新。

**完成判据**：gate3 已记录；`declined` 时 `writeback` 已记 `not-applicable` 并写明用户原因。

### 20. `writeback` · 回写 + 通知

批准后用 `tracker-writeback` 模式调 **fix-report**，带已有 `reportUrl`：

- `tracker.updateRecord(<id>, { <statusField>: <Gate ③ 批准的状态值>, <noteTextField>:'<摘要> · MR <url> · 报告 <url>', <followerField>:[<操作者/机器人 id>] })`（scratch 护栏）。
- 可见 UI 界面时，把 `before.png`/`after.png` 传到备注附件字段
  （`tracker.uploadAttachment`）。非 UI 问题省略截图附件。
- 发通知：`notify.deliverFixNotification(model)`（notify 适配器：`stdout` 打印；
  `lark` 部署态经 connector、本地 `lark-cli im`）。scratch 模式 `notifyOpenId`
  强制为操作者；real 模式是提出人。配置 `notify.chatId` 时改发群卡片；
  `notify.openId` 可以是姓名/邮箱——非 `ou_` 值经 `lark-cli contact +search-user`
  解析，命中多人时要求给出精确 open_id。用户在 Gate ③ 选了只回写时通知记 `not-applicable`。

`direct-evidence` 跳过整步：报告后即结束，把回写/通知明确标为 `not-applicable`。

**完成判据**：记录更新、附件（适用时）、通知各自有确认的后端结果（或各自独立的 blocked
原因）；一个失败不掩盖其他。

### 21. `audit` · 完成审计

最终回答前，`runstate.mjs show` 并逐条列出每个步骤、状态及其证据。不要仅因代码、模拟截图、
MR 或重跑请求存在就停。

**结局 `fixed` 的主流程成功**要求：已批准的定位与方案、红灯→绿灯证据、标注清楚的模拟
Before/After 证据（UI/可见界面问题，或有文档记录的 fixture 限制）或非 UI 问题的行为验证
说明，加上本地验证、当前 diff 的已校验 E2E 交接且无可行动缺口、复核裁决、已记录的手动
测试结果（`passed` 或显式 `deferred`）、已推送提交与 Draft MR（`forge=git` 时如实 pending；
用户在 Gate ② 选择 `keep-local` 时为本地提交 sha）、必需 CI 的终态（或写明原因的不适用）、
已发布报告，以及——`tracker-record`
——已批准的回写、适用的附件和通知。`tracker-record` 的附件仅适用于 UI/可见界面；非 UI 行为
说明没有截图附件。真实环境截图除非显式请求否则 `not-applicable`/`skipped`，不得阻塞
主流程完成。

**无改动结局**要求：Gate ① 批准的结局与证据、已发布的调查报告（`abandoned` 除外）、
（`tracker-record`）Gate ③ 的答复与对应回写。**所有结局**都要求：档的每一步达到了该档的
最低深度（sizing.md），`followUps` 已列出，dev server 已 `stop`，探针 worktree（若建过且
干净）已 `git worktree remove`——它有任何改动就保留并报告。

适用的主步骤还是 `pending`/`running` 就继续；`blocked` 就问最小解锁动作并保留恢复状态。

完成后 worktree 在其 MR 打开期间保留；只能经 `worktree-cleaner` 移除
（盘点 → 留/删清单 → 用户确认）。

**完成判据**：`runstate.mjs resume <runDir>` 返回 `complete`（每个步骤都是 `done` 或
`not-applicable`），且上面对应结局的每一项都能指向一个已存在的产物、URL 或命令输出。

## 可选真实环境后续——仅在完成后

对 UI/可见界面问题，第 20 步（`direct-evidence` 为第 18 步）完成且主结果已交付后，邀请
用户**回复一个环境 lane**（例如 `staging-x`、`canary-y`）做一次真实页面截图。不跑
`deploy.mjs find` 或 `deploy.mjs deploy`；后续只接受用户给的 lane 或已确认的部署输出。
用户主动要求触发/查询部署时，优先仓库自己的 pipeline 工具；`deploy.mjs` 只作无配置环境的
脚本兜底。

收到该回复时，用 `real-env` 模式调 **before-after-capture**，带 Gate ① 已定的精确绝对
`productEntryUrl`、定位路由、selector、视口。绝不从任务 host、分支名、service id 或命名
约定推导 web 入口或 lane。复用认证主浏览器，按 `capture.envHeaders` 模板配置环境路由头
（如 `x-env: <lane>` + `x-preview: 1`），然后做一次兼具认证检查、路由验证与截图的
导航。成功返回 `real.png`；重定向或缺 selector 就返回具体 blocker，不试别的域名、header、
lane、凭据或浏览器 profile。该后续绝不重开或使已完成的主流程失效。

## 分支情形与失败处理

- **特殊情形**（回归、已在最新基线修复、无法复现、间歇性、多个问题、重复/已有人在修、根因
  在外部、配置/开关、数据已写坏、已有测试断言错误行为、生成代码、性能、i18n、可访问性、
  特定浏览器、安全、基线前进、热修复分支、范围蔓延、熔断、MR 评审意见、会话中断续作、
  MR 已合并）→ 命中信号时读 [references/situations.md](references/situations.md) 对应条目。
- **脚本/适配器失败**（`ok:false` 或 `kind` 分类错误、scope/权限/限流、tracker 空结果、
  附件 403、认证墙、缺配置、MR `deployPending`、推送被拒、认领后中途失败、依赖安装失败、
  worktree 冲突）→ 读 [references/failures.md](references/failures.md)。绝不编造结果；某步
  完成不了就标记它，流水线其余继续。

## 部署模式映射（运行时集成）

- 门禁表达为运行时的**原生提问能力**（AskUserQuestion / 等价物）——部署态运行时把它
  渲染成交互卡片，门禁免费变成 HIL。
- 最终通知经 `notify` 适配器发送：`lark` 类型在部署运行时（`FIXER_AGENT_SERVER_WS` +
  `FIXER_AGENT_THREAD_ID` + `FIXER_CONNECTOR_PACKAGE` 存在）经 connector 发
  `FIXER_CONNECTOR_METHOD`（默认 `plugin/event/publish`）；本地回退 `lark-cli im`
  DM/群卡片；`stdout` 类型只打印。自建表单可用桥的 `hil_form_schema` +
  `plugin_event_publish` 回传，无需自建回调 server。
- 进度清单用 ` ```fixer:progress` 块随 assistant 文本流出；部署态桥可以渲染它，本地是
  可读清单。

## 输出

以简洁的运行总结收尾：来源 + 记录/本地问题 id、runDir、五个坐标（模式、分类、档、改动面、结局）、
根因一句话、定位文件、worktree 路径 + 分支 + 基线 SHA、红灯→绿灯、验证结果、复核裁决、
MR（url 或 pending 命令）、模拟证据、可选真实环境结果、报告 url、通知 message id、
followUps、以及遇到的每个 scope/部署缺口（附关闭它所需的确切命令/scope）。视觉截图成功时，
渲染返回的 `conversationMarkdown` 让最终回答可见地展示证据。`direct-evidence` 把通知/回写
报为 `not-applicable`，不是缺失。无真实环境截图的 UI/可见界面问题，用一句短邀请收尾：回复
环境 lane 即可在真实页面截同一状态。主结果交付前不要问环境。无可见界面的非 UI 问题不要
提供截图后续。

即使部分运行也返回这些字段，让后续调用能安全恢复：

```yaml
source: tracker-record | direct-evidence
issueId: string
recordId: string | not-applicable
runDir: string
classification: ui | runtime-error | backend | data | performance | config | security | unknown
tier: S | M | L | XL
tierHistory: [{ from: string, tier: string, reason: string }]
surface: style-copy | logic | user-visible-protocol | performance
severity: { level: sev1 | sev2 | sev3 | sev4, source: inferred | reported }
outcome: fixed | already-fixed | cannot-reproduce | not-a-bug | duplicate | needs-decision | external | escalated | split | abandoned
fixKind: root-cause | workaround | mitigation | not-applicable
fingerprint: string
repro: { status: reproduced | not-reproduced | not-attempted, method: string, observed: string }
rootCause: { chain: string, regressionOf: string | not-applicable }
localization: { file: string, line: number, productEntryUrl: string | not-applicable, route: string | not-applicable, confidence: high | medium | low }
redGreen: { check: string, red: string, green: string } | not-applicable
artifacts:
  runDir: string
  simulated: not-applicable | {
    before: string
    after: string
    states: [{ name: string, beforePath: string, afterPath: string, action: string }]
    compare: string
    conversationMarkdown: string
  }
  behaviorVerificationNote: string | not-applicable
  hypotheses: string
  realEnv: { lane: string, path: string, finalUrl: string } | not-applicable
verification: { baseline: string, result: string, newErrors: [] }
e2eCheck: { decision: needs-e2e | update-e2e | no-new-e2e, paths: [], ledger: [], changes: {}, commands: [], blockers: [] }
e2eHandoff: { resultPath: string, schemaVersion: issue-fixer-e2e/v1, sha256: string, diffHash: string, issueId: string, fingerprint: string }
review: { mode: self-checklist | bugfix-review, verdict: string }
manualTest: { prompt: {}, result: passed | failed | blocked | deferred | pending, evidence: string }
delivery: { worktree: string, branch: string, baseSha: string, mr: string, env: string | not-applicable, report: string, notification: string }
followUps: [string]
steps: { stepName: not-applicable | pending | running | done | blocked | failed }
blockers: [{ step: string, reason: string, resumeWith: string }]
```

`not-applicable` 只用于模式或结局排除的字段。步骤适用但未完成时用 `pending` 或 `blocked`。
绝不用计划中的 URL、命令或产物路径顶替已确认的结果。
