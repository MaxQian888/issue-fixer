# 特殊情形处置

主流程之外的分支。每条：**信号**（出现就读这一条）→ **处置** → **记录**（写进运行状态
或报告的字段）。多条同时命中时逐条处理；处置里要求回 Gate ① 的，先回 Gate ①。

## 输入类

### 一条输入里有多个问题
- 信号：描述里有多个独立症状、多张截图指向不同页面、"顺便还有…"。
- 处置：先判断是否同一根因（同一代码路径/同一错误状态）。同根因 → 一个 run，指纹列全部
  症状。不同根因 → 结局 `split`，Gate ① 呈现拆分表（子问题、指纹、建议顺序、依赖关系），
  批准后逐个开 run。
- 记录：父 run `outcome=split` + 子 run issueId 列表。

### 证据互相矛盾或不足
- 信号：文字与截图对不上、截图拿不到、描述只有"不好用"。
- 处置：不按行位或猜测继续。列出矛盾点，问**一个**最能消除歧义的问题（优先让提出人
  指认元素、给复现步骤或原始截图）。
- 记录：`intake` 或 `triage` 记 `blocked`，`waitingFor` = 那个问题。

### 安全漏洞
- 信号：注入、越权、敏感数据泄露、凭据出现在代码/日志、依赖 CVE。
- 处置：档至少 L。读仓库 `SECURITY.md`/披露策略。MR/PR 标题、正文、提交信息、报告只写
  "修复 <模块> 的输入校验"这类不含利用方式的描述，复现细节放 `<runDir>` 不外发。推送到
  公开 forge 前在 Gate ② 单独确认。发现的真实凭据只报告位置，不复制、不打印。
- 记录：`classification=security`，报告注明披露级别。

## 定位与根因类

### 回归（"以前是好的"）
- 信号：提出人给了"上个版本正常"、时间点、版本号；缺陷行最近被改过。
- 处置：按 [diagnosis.md](diagnosis.md) §3 找引入提交（`git log -S/-L`、`blame`、有界
  `bisect run`）。可独立回退时，Gate ① 给"回退 vs 前向修复"两个选项。
- 记录：`regressionOf`；MR 正文写 "Regression from <sha>"。

### 最新基线已修复
- 信号：在刚 fetch 的 `origin/<base>` 上（探针 worktree，见 SKILL.md 第 3 步）复现不出；
  提出人用的是旧版本/旧环境。
- 处置：`git log <提出人版本>..origin/<base> -- <相关路径>` 找修复提交；结局
  `already-fixed`。提出人所在的发布线仍受影响时，把"是否回合到发布分支"作为 followUp
  问用户，不自动做。
- 记录：`fixedBy`。

### 无法复现
- 信号：按描述在可控维度下都正常。
- 处置：做 IS / IS NOT 表（[diagnosis.md](diagnosis.md) §1），按差异最大的维度再试；
  仍不复现就问提出人那一个维度，结局 `cannot-reproduce`。用户补充后回到 `locate`。
- 记录：`investigation` 每次尝试 + `needInfo`。

### 间歇性 / 时序 / flaky
- 信号：偶发、刷新就好、只在慢网络/并发/首次加载出现。
- 处置：档至少 M。重复 N 次（默认 20）记失败率；找竞态、超时、缓存、顺序依赖。修复要用
  同样的 N 证明失败率下降。加 sleep、加重试、调大超时只能是 `fixKind=mitigation` 并单独批准。
- 记录：前后失败率与 N。

### 根因在别的仓库 / 第三方依赖 / 后端服务
- 信号：栈顶的错误状态来自依赖或远端响应；本仓代码按契约正确处理了输入。
- 处置：结局 `external`：写交接说明（症状、复现、证据、期望的契约）给归属方。本仓规避
  （`fixed` + `fixKind=workaround`）需在 Gate ① 单独批准，并注明何时可以移除。改依赖版本、
  打补丁（patch-package 之类）档至少 M，lockfile 变化在 Gate ① 明示。
- 记录：`owner`、`handoff`、（规避时）`fixKind`。

### 配置 / feature flag / 环境数据问题
- 信号：代码正确，某个开关、远端配置、环境变量或数据取值导致症状。
- 处置：远端配置、线上开关、生产数据由人处理——结局 `external`，交接说明写清要改什么值。
  仓库内提交的配置文件（默认值、环境配置）是代码改动，档至少 M，按正常流程修。
- 记录：`classification=config`。

### 已有数据被写坏
- 信号：修复能阻止新的坏数据，但历史数据仍错误。
- 处置：代码修复照常走。历史数据修复（回填/迁移脚本）是单独的 followUp：可以在 Gate ①
  里提议并在本次 diff 里附脚本（档至少 L），但执行脚本永远不由本流水线做，也绝不对生产数据
  运行。
- 记录：`followUps` 写明受影响数据范围与修复脚本位置。

### 已有测试断言了错误行为
- 信号：修复后某个既有测试失败，且它断言的正是所报的错误行为。
- 处置：档至少 M，回 Gate ① 说明：哪个测试、它断言了什么、为什么那是缺陷（规格/设计/
  提出人的期望）。批准后只改对应断言，不重写整个测试。
- 记录：Gate ② 卡片与 MR 正文单列"测试预期变更"。

### 生成代码
- 信号：缺陷行在生成文件里（文件头有 generated 标记、位于 `gen/`/`__generated__`、
  由 codegen 脚本产出）。
- 处置：改生成源（schema/IDL/模板/配置），用仓库的生成命令重新生成，二者一起提交。
- 记录：`planSummary` 写明生成源与生成命令。

### 性能问题
- 信号：慢、卡、内存涨、包体大。
- 处置：档至少 M。`red` = 基线实测（指标、方法、样本量、数据规模）；修复后同法实测。
  没有前后数据就不宣称提升；给不出测量方法先和用户对齐。
- 记录：`classification=performance`，报告给前后数据表。

### i18n / 文案
- 信号：文案错误、缺翻译、某语言下截断/溢出。
- 处置：走仓库 i18n 管道，所有语言的 key 一起处理；布局相关时在最长的语言下截
  before/after。
- 记录：改动的 key 列表。

### 可访问性
- 信号：读屏读错、键盘无法操作、焦点丢失、对比度不足。
- 处置：修语义（role/name/state/焦点顺序）而不是只改样式；仓库有 axe/lighthouse 之类
  检查就跑，没有就在行为验证说明里写键盘/读屏操作步骤与结果。
- 记录：检查命令或手动步骤。

### 特定浏览器 / 平台
- 信号：只在某浏览器、某 OS、某设备复现。
- 处置：记录引擎与版本；验证在同一引擎上做（仓库 Playwright 配置里有对应 project 就用它）；
  做不到就在限制里写明，并把该平台写进手测提示。
- 记录：`repro.environment`。

## 执行类

### 已有人在修 / 重复
- 信号：同一 issueId 的分支或 worktree 已存在；开放 MR/PR 提到同一记录或改同一文件；
  tracker 状态已是 claimed/done/fixed。
- 处置：动 worktree 前查：`git worktree list`、`git branch -a --list '*<issueId>*'`、
  forge 上按记录号/关键词搜开放 MR/PR（`gh pr list --search <关键词>` 或仓库等价工具）。
  属于本 run 的续作 → 复用；属于别人 → 结局 `duplicate` 或问用户是否协作，绝不覆盖。
- 记录：`duplicateOf`。

### 用户主 checkout 有相关的未提交改动
- 处置：先问哪些改动属于本问题，再搬进 worktree；绝不 stash/还原别人的改动（见 SKILL.md
  第 6 步）。

### 基线在运行中前进了
- 信号：Gate ② 前置检查里 `origin/<base>` 已不等于 `$BASE`。
- 处置：见 SKILL.md 的 Gate ② 前置检查。改动文件被上游动过、有冲突、仓库要求线性历史或
  MR 流程要求最新基线 → `branch-sync` rebase，`meta --base-sha <新基线>`，`reopen red`：
  在探针 worktree 切到新基线（`git -C <runDir>/probe checkout --detach origin/<base>`），
  只带入回归测试文件（`git -C <runDir>/probe checkout <修复分支> -- <测试文件>`）跑一次——
  仍红说明问题在新基线仍在，继续；转绿说明上游已修，`reopen locate` 后结局改
  `already-fixed`。跑完用 `git -C <runDir>/probe checkout -- . && git -C <runDir>/probe clean -fd`
  还原探针（它只属于本 run）。UI 在新基线重截 `before`。之后验证、证据、E2E（对比点变了，
  旧交接失效）、复核、提交与 Gate ② 依次重走。上游动的都是无关文件且无上述要求 → 不 rebase，
  在 Gate ② 卡片里写落后的提交数。
- 记录：新的 `baseSha`、rebase 前后的 HEAD。

### 热修复 / 发布分支
- 信号：用户指定修在 `release/*` 之类的分支，或问题只存在于某个发布线。
- 处置：该分支就是本 run 的 `<base>`（覆盖 `FIXER_BASE_BRANCH`），探针 worktree、修复
  worktree、MR 目标都用它。回合到主干或其他发布线是 followUp，由用户决定，不自动
  cherry-pick。
- 记录：`runstate.mjs meta --base-branch <分支>`，原因写进 Gate ① 卡片。

### 范围蔓延
- 信号：修的过程中发现相邻问题、想顺手重构、想统一格式。
- 处置：不进本次 diff。写进 `followUps`；与本问题同一根因且在已批方案内的例外，按
  [diagnosis.md](diagnosis.md) §4 处理。需要扩大范围 → 回 Gate ①。
- 记录：`followUps`。

### 熔断
- 信号：失败假设数达到档预算、定位两轮达不到 medium、手测连续两次失败。
- 处置：按 [sizing.md](sizing.md) 的熔断规则停、留现场、`reopen locate`、带假设日志回
  Gate ①。
- 记录：`hypotheses.md`、`tierHistory`。

### MR 创建后的评审意见
- 信号：用户要求处理 MR/PR 上的评论。
- 处置：每条评论当作论断走 `claim-verify-first`；证实要改的，`reopen fix` 后在同一 worktree
  内改，重走验证、证据、E2E、复核、提交与 Gate ②（卡片展示相对上次推送的增量），批准后
  推送更新同一个 MR。证否的给出反证，不改代码。评论的拉取与回复用仓库/forge 自己的工具。
- 记录：每条评论的判定与对应提交。

### 会话中断 / 上下文压缩后续作
- 处置：不记得 runDir 时 `runstate.mjs list` 列出全部 run（runId、指纹、恢复点、更新时间），
  按指纹或 issueId 认领；`runstate.mjs show <runDir>` 取恢复点；重新校验指纹、worktree HEAD、当前
  diffHash；从第一个未完成步骤继续，已完成的外向动作（认领、推送、MR、报告、回写、通知）
  先查已存在再决定，绝不重复。

### MR 已合并或关闭
- 已合并：本 run 的交付完成；worktree 按 `worktree-cleaner` 盘点 → 清单 → 用户确认后清理。
  tracker 的最终状态（已修复/已验收）由人更新，除非用户在本轮明确要求。
- 未合并就被关闭：交付没有完成。问用户：重新打开并继续（`reopen` 到对应步骤）、改方案
  （`reopen locate`）、还是放弃（`reopen locate` 后 Gate ① `abandon`）。tracker 状态不动。
