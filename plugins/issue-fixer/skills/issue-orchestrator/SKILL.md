---
name: issue-orchestrator
description: >-
  端到端修复**一个**问题，输入可以是已配置 tracker 的一条记录或用户直接提供的证据。
  用户跑 /fix-issue、提到 tracker/工单问题、或发来带截图/报错/堆栈/runId/logid/
  复现步骤的问题描述并要求修复/调整时必须使用——即使没有 tracker、record_id 或"修复"字样。
  直接证据跳过 tracker 查询。默认 UI 流程：定位 → 门禁 → 隔离 worktree 修复 → 验证 →
  模拟 before/after → E2E 覆盖检查 → 用户测试/MR 门禁 → MR/CI/报告，tracker 记录输入另有
  最后的回写门禁。非流水线输入（工作项、未验证论断、CI/MR/分析请求）委派给内置工作流
  skills。真实环境截图是完成后的可选后续，需要显式 lane。
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
解析为**目标仓库主 checkout**：它供给 worktree 来源（第 4 步）并承载
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
（`FIXER_ARTIFACTS_DIR` 可覆盖），存放问题指纹、基线日志、模型 JSON、截图、对比页、
报告 markdown。绝不提交该目录。

## 运行状态

每一步按 `not-applicable | pending | running | done | blocked | failed` 跟踪。外向步骤
blocked 不抹掉已完成的本地工作。重新校验输入后从第一个未完成步骤恢复；不检查是否已成功
就不重复认领、MR 创建、报告发布或通知。

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
  不要为它跑 tracker 查询或本流水线门禁。
- **未验证的论断**（"看看这个是不是问题"、review 评论、二手 bug 转述、性能声明）→ 先调用
  `claim-verify-first`。证实的问题带着判定作为证据以 `direct-evidence` 回到这里；被证伪的
  以反证结束，不做编辑。
- **其他一切**（CI 事故、任务 URL、MR 续作/rebase、纯分析）→ 按 `input-dispatch`
  §0 分流；本修复流水线不拥有这些输入。

`[issue-fixer:direct-evidence]` 标记是显式的 `direct-evidence` 决定。不要仅因本
skill 也支持 tracker 就推翻它。

## 硬规则

- **只用适用的门禁**（其余全自动跑）。两种模式都用定位门禁 ① 和 MR 前门禁 ②。只有
  `tracker-record` 用回写门禁 ③；`direct-evidence` 没有东西可回写，不许造出第三个门禁。
- **Scratch 护栏**：`FIXER_TARGET != real` 时，绝不改生产 tracker，绝不 @/私信真实提出人。
  `config.mjs` 的 `assertTrackerWritable` 替你强制这一点；保持它生效。
- 每个定位断言都引 `file:line`。代码改动保持外科手术式。
- 行号只是选择器，永远不是问题语义。建分支或编辑前，确认**问题指纹**。`tracker-record`
  包含解析出的 `recordId`、问题描述、模块、优先级、原始截图（或其确切不可用原因）。
  `direct-evidence` 包含 source=`direct`、用户原文描述、所供证据、以及明确标注为推断的
  区域/优先级。
- 任何下游步骤宣称成功前先跑能力与仓库 preflight。
- **模拟证据优先**：UI 修复用确定性组件 fixture 产出标注清楚的模拟 Before/After。默认
  截图不做认证探测、不发现/部署环境、不起完整产品栈。fixture 无法呈现所报状态或需要活体
  检查时，用 `before-after-capture` 的 **`local-dev`** 通道——worktree 上一个常驻 dev
  server 连远程后端——绝不做环境发现/部署。真实环境证据是单独的可选后续，不得阻塞
  主流程完成。
- **用户输入能解锁时就主动问。** 不要只报"缺环境""权限被拒""认证卡住"。立即问出所需的
  最小具体输入或动作（例如：仓库路径、目标路由、环境名、浏览器登录、scope 授权、原始
  截图），说明怎么提供，并说明之后从哪一步恢复。尽可能一次只问一个聚焦问题。

## 进度披露（框架原生）

跑步骤时，**以 assistant 文本发出进度清单**。每次步骤转换后，在你叙述的回复里带上更新后
的 ` ```fixer:progress` 标记块——部署态运行时的 turn 流式事件会把它随文本同步到
消息桥，本地则是一段可读清单：

```
node <root>/scripts/progress.mjs "取证:done,定位:running,基线:pending,改码:pending,验证:pending,截图:pending,E2E:pending,用户测试:pending,MR:pending,CI:pending,环境:skipped,报告:pending,回写:pending" "修复 <issue_id>"
```

步骤可在外部输入后恢复时用 `blocked`；所选模式不适用时用 `skipped`。真实环境在主流程中
始终 `skipped`，即使早就拿到了 lane；把该 lane 排进完成后的后续。无可观察界面的非 UI
问题把截图标 `skipped`。`direct-evidence` 把回写标 `skipped` 并注明 `direct-evidence`，
或省略。

助手生成这个 fenced 块，但它的 Bash/工具 stdout **不是** assistant 文本流的一部分。
把生成的块原样拷进 assistant 文本；不要只跑命令。每次转换都发（刚完成的步骤 → `done`，
下一个 → `running`）。

## 流程

**0A. `tracker-record`：先 preflight 数据访问，再 解析 + 读取 + 认领。** 先跑
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

**0B. `direct-evidence`：接受当前回合作为输入。** 不执行 0A。逐字保留用户描述并检查每个
提供的图片/文本产物。用一个简短问题 slug 给分支/产物名建稳定的本地 `issueId`（实在没有
稳定 slug 才退到时间戳）。记 `source=direct`；tracker 身份、访问、认领、附件下载全部是
`not-applicable`，不是失败。所供证据确实不足以指认症状时，问一个聚焦问题；绝不只因没有
tracker 选择器就去要一个。

**1. 收集证据，建问题指纹。** `tracker-record` 中经 `tracker.mjs download` 下载
问题截图。私有附件 URL 不是图片已读的证据。403/scope 失败时保留确切错误并把截图标记为
不可用。解读图像前先展示解析出的记录指纹。`direct-evidence` 中直接用当前回合的文本与图片
输入，不做任何 tracker 兜底。描述与截图不足或矛盾时，问而不是按行位猜测。

记录描述或用户输入里的飞书链接不是"读过"——先取回再引用：跑
`node <root>/scripts/evidence.mjs collect --record-file <record.json> --out <runDir>/evidence`
（direct-evidence 用 `--text "<输入>"`）。它把 docx/wiki 拉成 markdown、minutes 拉摘要+逐字稿、
`om_` 消息连同图片附件一起下载；sheets/file 链会标 `manual` 由你补抓。清单落在
`evidence-manifest.json`——`failed` 的链接摆出来，不要假装读过。

只要缺的证据是用户能提供的，现在就主动要。例如：请用户上传原始截图、确认解析出的记录
描述、或指认目标元素。不要带着猜测继续等。

**2. 分诊，再定位。** 先分类——**不是每条记录都是 UI 修复**：
- **UI / 视觉 / 交互**（布局·尺寸·样式·文案·错位·间距·颜色）→ 调 **ui-issue-localize**
  （截图→组件）。before/after = 截图。
- **报错 / 崩溃 / 白屏 / 后端 / 接口 / 数据**（stack trace、500/4xx、"点击无反应"、"报错"、
  runId/logid/白屏）→ 用仓库的日志/排障工具做日志驱动定位，**不**用截图。
  "before/after" 变成 复现→修复行为说明（有可见界面时才附截图）。
- **不确定 / 描述过短 / 无截图** → 动代码前先问（本地 AskUserQuestion；部署模式下运行时的
  原生提问卡片）——不要猜。

证据里的结构化输入先走对应解析器而不是手抠：工单 URL/ID → 配置的工作项抓取
（`workitemFetchCommand`）或对应 skill；跨仓定位或"这功能在哪个仓库实现" → 仓库的
代码搜索工具。解析失败保留确切错误，不要凭链接样式猜内容。

返回候选 `file:line`、复现路由/步骤、建议的最小改动。

定位已确认但**最小改动方案本身需要探索**（多种合理交互形态、状态模型/流转拿不准、
靠读码无法判断哪种行为对）时，先调 **`prototype`** 做一次性打样验证，把结论连同定位
一起带进 Gate ①。原型是一次性产物：写在 worktree 里跑给用户看可以，但不 stage、不进
交付 diff、不算验证证据。

**3. 🚦 GATE ①。** 展示：问题、已知的模块/优先级、定位到的 `file:line`、建议改动、
问题指纹。`classification=ui` 或其他可见界面时，同时定下后面截图要用的精确绝对
**product entry URL**（`capture.productEntryUrl` 或当场确认）和**目标路由**。等待批准。
被拒就在定位上迭代。**此门禁之前不建分支、不编辑、不截 "after"、不推送、不开 MR。**

把批准与展示的精确指纹和方案一起记录。之后任一发生实质变化（不同组件、路由或行为），
回到 gate ①。已批方案内的行号移动或实现细节不需要再过一次门禁。

若分诊或 gate ① 发现这其实是个大改动或有分叉的改动（方案有分叉/需评审），停下本流水线，
先按仓库自己的评审惯例产出可评审的设计文档——一条 tracker 记录不会把大改动缩成快速修复。

**4. 隔离 worktree、preflight、基线，然后修复。** 绝不编辑用户主 checkout。按
`worktree-flow` §1–2（其完成判据适用）从新 fetch 的远程基线建同级 worktree：

- `git -C <FIXER_REPO_DIR> fetch origin <base>`，`<base>` = `FIXER_BASE_BRANCH`；
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

编辑前在 worktree 内 preflight：

- 检查包管理器配置、`NODE_ENV`、workspace link、lockfile、patched 依赖。
  lint/typecheck/test 需要时显式安装 devDependencies；不要让 `NODE_ENV=production`
  静默丢掉工具链二进制。
- 优先仓库锁定安装。若因 lockfile 与 patch 元数据不一致失败，报告该不一致并用仓库文档的
  恢复方式；不要作为无关修复的一部分静默规范化或重写 lockfile。
- 在未动的基线上跑一遍相关 lint/typecheck 并留存输出。
- 缺 lint/typecheck 二进制是 preflight 失败，不是豁免验证的许可。恢复锁定的
  devDependencies，或跑仓库支持的 CI 等价命令。仍不可行就把验证标 `blocked`；绝不用
  "纯 CSS，低风险"顶替。

然后编辑前记录对比点 SHA（$BASE）。`classification=ui` 时趁树还在 $BASE 现在就截基线
`before` 产物——第二个干净 worktree 只是编辑后恢复的兜底。然后做外科手术式编辑。
复查定位 skill 标出的耦合布局值。

**5. 验证。** 所有命令在 worktree 内跑。深度按 `repo-collab` 验证分级——纯样式/文案 →
lint + 视觉证据；逻辑/缺陷 → 最窄归属层测试 + 受影响包 build；用户可见或协议变化 → 下面的
E2E 阶段；性能 → 实测前后数据。各档命令优先取 `verify.lint`/`verify.typecheck`/
`verify.test` 配置，未配置时按 `worktree-flow` 的 `references/verify-matrix.md` 从仓库
工具链推断；watch 模式的 test runner 永远带显式 run 参数（裸 `vitest` 是 watch 会挂起）。
UI/可见界面问题，确认目标路由能加载——已有 `local-dev` server 在跑就复用；不要仅为这个
检查单起 server。dev server 和浏览器会话在 修复→验证→截图 循环中保持温热，只在依赖/
环境变化时重启。无路由的非 UI 问题，用留存的复现作为定向行为检查。结果与留存的基线对比：
既有的工作区/构建错误必须单列，改动文件里的任何新错误是阻塞项。门槛 = 无新 lint/类型
错误 + 定向行为检查 + 适用的路由加载；绝不把全红基线描述成"pass"。

**6. 模拟 Before/After 截图（默认）。** 调 **before-after-capture** 的默认
`simulated-component` 模式——记录的改动前 commit 是 $BASE，其 `before` 产物已在第 4 步
编辑前截好；干净基线 worktree 只是编辑后恢复的兜底。在确定性 fixture 中渲染定位到的组件，
基线与改后修订用同样的 props、视口、主题、数据、交互状态。产出 `before.png`、`after.png`、
`compare.html`、`conversationMarkdown`。图片与报告标注为模拟组件证据；绝不当作真实产品页。

这步就是捷径：不做认证探测、不找环境、不部署、不起完整产品栈、不试产品域变体。
用户原始截图是视觉参考，不是基线产物。fixture 无法呈现所报状态时，先切 `local-dev` 通道
——worktree 上一个常驻 dev server 连远程后端（`capture.devServerCommand`）——再考虑记为
限制；`local-dev` 截图是活体路由证据，仍不是部署环境证据。

本截图步骤只适用于 `classification=ui` 或其他确认的可见界面。无可见界面的非 UI 问题，
把截图产物标 `not-applicable`，保留复现 + 修复行为作为行为验证说明。

有状态的视觉改动（hover/focus/展开/收起/加载中），在该 skill 定义的状态矩阵上对两个修订
都截。一张修复后截图或两个修复后交互状态不是 before/after 对比。

截图成功时，把返回的 `conversationMarkdown` 原样渲染进会话正文和最终回答。
**before-after-capture** 是唯一呈现契约；不要重建或替换成第二种格式。报告与通知是独立的
交付产物。

**7. E2E 覆盖检查。** 调 **e2e-check**，带记录的 $BASE 对比点 SHA、worktree 真实产品 diff
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

**8. 提交 + 推送。** 在 **worktree 内**用仓库自己的提交约定（Conventional Commit、
scope = 真实包名/模块名；部署态配置允许时加 `Co-Authored-By`）。`config.repoRules`
注入的仓库硬规则在此生效——测试落位、i18n 接线、changeset/发布约定、staging 纪律都按
它的字面执行，缺哪条补哪条，不拿"通用流程"当豁免。只 stage 映射到验收点的
文件——先 `git status`，确认无无关文件才 `git add -A`。测试代码保界按
`workitem-quick-fix`：仍覆盖契约的通过测试/E2E 不动；预期行为变化迫使测试调整时，
证明因果并保持最小。然后 `git push -u origin HEAD`。Gate ① 的已批方案加 gate ② 的
MR 批准是本流水线的显式推送授权；流水线外的推送仍要 `repo-collab` 的逐指令授权。

**9. 🚦 GATE ②——用户测试结果，然后 MR。** 展示 diff 摘要、分支、E2E 决策/结果，复述
**e2e-check** 已发出的确切 `manualTestPrompt`。请用户回报 `passed`、首个失败步骤加证据、
具体环境 blocker、或显式 deferred 手动测试。这仍是既有的 MR 前门禁：用户显式批准建 MR 时
允许 defer 手动测试。用户发现失败就回到适用的修复与截图步骤，再重做验证、E2E、提交、推送
和本门禁，让 MR 不指向过时代码。受影响路径变化时重新生成提示。批准后创建到
`FIXER_BASE_BRANCH` 的 **Draft** MR/PR：**优先仓库的 MR 工具/插件**；不可发现时用脚本兜底
`node <root>/scripts/mr.mjs create --head fix/agent-<id> --base <FIXER_BASE_BRANCH>
--title <t> --body-file <body.md> --cwd <worktree> [--reviewers ...]`，走 `forge`
适配器（`git` 返回 deployPending、`github` 走 `gh`——自动从 origin remote 解析
owner/name、按 head 去重并更新已有 PR 的标题/正文、`custom` 走 `forge.mrCommand` 模板）。
填仓库的 MR 模板（Summary/Changes/Test Plan 或等价物）。`direct-evidence` 省略
reviewers，除非用户给了。返回 `deployPending`（forge 不可用/未配置）时，摆出确切命令并
继续（报告/回写仍进行，带 MR-pending 备注）。

MR 创建前后各有一次生态侧自查位，用则有保障但都不阻塞本门禁：
- **建 MR 前**：用仓库可用的 review 能力，拿报告的问题与验收点复查当前 diff 是否真的
  解决它；发现"改了但没修到"时回到修复步而不是带病开 MR。
- **关联工作项**：tracker/工单来源的 MR 需要回填关联时，用 tracker/forge 提供的关联机制，
  不在此处手写平台 API。

**9b. CI 跟进。** MR 存在后，检查所有必需检查并在环境正常超时内等终态。`forge=github`
时用 `node <root>/scripts/mr.mjs checks --head <branch> --cwd <worktree>` 拿按
`pass/pending/fail` 分桶的检查列表与链接（`gh pr checks`）；其他 forge 用仓库自己的
CI 工具。检查失败时：

1. 拉完整的失败 job 日志，记录 job/check 标识、attempt 号、失败断言、改动文件重叠度、
   同一失败在基线/默认分支是否已存在。仅凭路径不匹配不足以证明失败无关。
2. 分类为 `caused-by-change | pre-existing | flaky | infrastructure | unknown`，带证据。
   日志未拉全时保持 `unknown`。
3. `caused-by-change` 要修。可信的 flaky/基础设施失败最多自动重跑一次，然后等并记录其
   终态。重跑成功是 flaky 的证据；仅接受重跑请求不是。
4. 重跑仍失败或换了错误，别再叫它无关，诊断它。

检查在跑时 CI 步骤保持 `running`；权限挡住检查/重跑时 `blocked`；确认由改动引起的失败
仍在时 `error`。独立的报告工作继续，但必需 CI 未了不得宣称交付完成。MR 评审意见处理走
仓库自己的评论/评审工具，不在此自实现评论拉取。

开 MR 之前，再对仓库做一次快照并用指纹和当前 diffHash 重读 `e2e-result.json`。E2E 之后的
任何代码、fixture、测试编辑都使交接失效并回到第 7 步。

**10. 报告。** 用 `report-only` 模式调 **fix-report**，带完整模型（source、issue、locate、
plan、diff、verify、compare.html、E2E 交接回执、手动测试结果、MR/task 链接）。它构建
markdown 并经 `report` 适配器发布（`markdown` 落产物目录、`lark-docx` 发飞书文档、
`custom` 走 `report.publishCommand`）；记下 URL。

**11. 仅 `tracker-record`——🚦 GATE ③，然后回写 + 通知。** 展示将写入的内容。批准后用
`tracker-writeback` 模式调 **fix-report**，带已有 `reportUrl`：

- `tracker.updateRecord(<id>, { <statusField>: <status.done>, <noteTextField>:'<摘要> · MR <url> · 报告 <url>', <followerField>:[<操作者/机器人 id>] })`（scratch 护栏）。
- 可见 UI 界面时，把 `before.png`/`after.png` 传到备注附件字段
  （`tracker.uploadAttachment`）。非 UI 问题省略截图附件。
- 发通知：`notify.deliverFixNotification(model)`（notify 适配器：`stdout` 打印；
  `lark` 部署态经 connector、本地 `lark-cli im`）。scratch 模式 `notifyOpenId`
  强制为操作者；real 模式是提出人。配置 `notify.chatId` 时改发群卡片；
  `notify.openId` 可以是姓名/邮箱——非 `ou_` 值经 `lark-cli contact +search-user`
  解析，命中多人时要求给出精确 open_id。

`direct-evidence` 跳过整步：没有记录或提出人可更新。报告后即结束，把回写/通知明确
标为 `not-applicable`。

**12. 完成审计。** 最终回答前，逐条列出每个适用步骤及其证据。不要仅因代码、模拟截图、
MR 或重跑请求存在就停。主流程成功要求：已批准的定位、标注清楚的模拟 Before/After 证据
（UI/可见界面问题，或有文档记录的 fixture 限制）或非 UI 问题的行为验证说明，加上本地验证、
当前 diff 的已校验 E2E 交接且无可行动缺口、已记录的手动测试结果（`passed` 或显式
`deferred`）、已推送提交、Draft MR、必需 CI 的终态、已发布报告，以及——`tracker-record`——
已批准的回写、适用的附件和通知。`tracker-record` 的附件仅适用于 UI/可见界面；非 UI 行为
说明没有截图附件。真实环境截图除非显式请求否则 `not-applicable`/`skipped`，不得阻塞
主流程完成。适用的主步骤还是 `pending`/`running` 就继续；`blocked` 就问最小解锁动作并
保留恢复状态。

完成后 worktree 在其 MR 打开期间保留；只能经 `worktree-cleaner` 移除
（盘点 → 留/删清单 → 用户确认）。

## 可选真实环境后续——仅在完成后

对 UI/可见界面问题，第 11 步完成且主结果已交付后，邀请用户**回复一个环境 lane**（例如
`staging-x`、`canary-y`）做一次真实页面截图。不跑 `deploy.mjs find` 或 `deploy.mjs deploy`；
后续只接受用户给的 lane 或已确认的部署输出。用户主动要求触发/查询部署时，优先仓库自己的
pipeline 工具；`deploy.mjs` 只作无配置环境的脚本兜底。

收到该回复时，用 `real-env` 模式调 **before-after-capture**，带 Gate ① 已定的精确绝对
`productEntryUrl`、定位路由、selector、视口。绝不从任务 host、分支名、service id 或命名
约定推导 web 入口或 lane。复用认证主浏览器，按 `capture.envHeaders` 模板配置环境路由头
（如 `x-env: <lane>` + `x-preview: 1`），然后做一次兼具认证检查、路由验证与截图的
导航。成功返回 `real.png`；重定向或缺 selector 就返回具体 blocker，不试别的域名、header、
lane、凭据或浏览器 profile。该后续绝不重开或使已完成的主流程失效。

## 失败处理与兜底（如何继续推进，而不是伪装成功）

脚本返回的是分类过的可行动结果——读懂再分支。绝不编造结果；某步完成不了就标记它，
流水线其余继续。

- **Scope 错误**（`kind: 'scope'`）：合理就换另一个身份（读=user，卡=bot）；否则摆出
  错误里的确切授权方式，把该步标 **deploy/scope-pending**，并在能解锁当前关键路径时
  主动请用户授权/完成。独立步骤继续，但不假装被卡的步骤完成了。
- **权限**（`kind: 'permission'`）：不要循环换身份；报告它。
- **Tracker 空结果**：仅在成功响应 + 元数据/直接记录交叉核对后才接受。否则按底层
  auth/scope/解析错误分类；绝不把 `[]` 当事实报。
- **限流**（`kind: 'rate_limit'`）：`runLark` 已带退避重试；仍失败就等一下重试单步，
  不重启流水线。
- **附件 403 / 无截图 / 描述为空**：按文字继续；描述太薄无法定位时，停在分诊问。
- **定位不确定/有歧义**（>1 个可疑组件，或症状未复现）：摆候选并在 GATE ① 问，不要盲改。
  提出人能指认元素就采用。
- **验证失败**（lint/typecheck 红、路由加载不了）：当 bug 处理——复现 → 一个假设 → 修 →
  worktree 内重跑。不绿不开 MR。失败是既有/无关的就说清楚，并把检查收窄到改动文件。
- **真实环境认证墙**（`authWall:true` 或重定向到登录/落地页）或**浏览器缺失**：首次路由
  尝试后停止可选真实截图。请用户在主浏览器登录并在目标页面可见后回复。不要替换已交付的
  模拟证据或重启主流程。
- **缺环境/配置**：点名需要的确切变量/值或目录，说明用户如何在不暴露秘密的情况下获取或
  提供，并立即问。绝不让用户把 token 或私钥贴进聊天；优先设进环境或完成交互登录，然后
  只要确认。
- **MR `deployPending`**（forge 未配置/不可用）：摆出确切命令并继续。报告 + 回写仍跑，
  诚实写"MR 待创建（命令见报告）"。本工作流不自动做环境部署。
- **head 分支已有 MR**：更新它而不是重复建。
- **Reviewer id**：tracker 身份与 forge 用户 id 通常不同——在 forge 运行处解析（或传
  邮箱）；解析不了就不带 reviewers 建 MR 并注明。
- **幂等/锁**：状态=claimed/done/fixed → 跳过（有人/上轮 owns it）。**认领后中途失败**，
  要么留 claimed 状态加备注，要么（real 模式）回滚到 open 免得卡住——按进展决定，并
  说明做了哪种。
- **不是本仓库问题/错仓库/超范围**：把记录标"无需修复/暂不修复"是人的决定——摆出建议，
  不要自己设。

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

以简洁的运行总结收尾：来源 + 记录/本地问题 id、问题类别（UI vs 报错）、定位文件、
worktree 路径 + 分支 + 基线 SHA、验证结果、MR（url 或 pending 命令）、模拟证据、可选
真实环境结果、报告 url、通知 message id、以及遇到的每个 scope/部署缺口（附关闭它所需的
确切命令/scope）。视觉截图成功时，渲染返回的 `conversationMarkdown` 让最终回答可见地展示
证据。`direct-evidence` 把通知/回写报为 `not-applicable`，不是缺失。无真实环境截图的
UI/可见界面问题，用一句短邀请收尾：回复环境 lane 即可在真实页面截同一状态。主结果交付前
不要问环境。无可见界面的非 UI 问题不要提供截图后续。

即使部分运行也返回这些字段，让后续调用能安全恢复：

```yaml
source: tracker-record | direct-evidence
issueId: string
recordId: string | not-applicable
classification: ui | runtime-error | backend | data | unknown
fingerprint: string
localization: { file: string, line: number, productEntryUrl: string | not-applicable, route: string | not-applicable, confidence: high | medium | low }
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
  realEnv: { lane: string, path: string, finalUrl: string } | not-applicable
verification: { baseline: string, result: string, newErrors: [] }
e2eCheck: { decision: needs-e2e | update-e2e | no-new-e2e, paths: [], ledger: [], changes: {}, commands: [], blockers: [] }
e2eHandoff: { resultPath: string, schemaVersion: issue-fixer-e2e/v1, sha256: string, diffHash: string, issueId: string, fingerprint: string }
manualTest: { prompt: {}, result: passed | failed | blocked | deferred | pending, evidence: string }
delivery: { worktree: string, branch: string, baseSha: string, mr: string, env: string | not-applicable, report: string, notification: string }
steps: { stepName: not-applicable | pending | running | done | blocked | failed }
blockers: [{ step: string, reason: string, resumeWith: string }]
```

`not-applicable` 只用于模式排除的字段。步骤适用但未完成时用 `pending` 或 `blocked`。
绝不用计划中的 URL、命令或产物路径顶替已确认的结果。
