---
name: e2e-check
description: >-
  分析任意仓库的真实代码 diff，把改动的行为映射到具体用户路径，产出手动测试提示，
  做断言级 E2E 覆盖审计，并用仓库现有 E2E harness/skills 补齐或更新缺失的 E2E 测试。
  在实现修复或功能后、跑 /check-e2e、或其他插件在 MR/PR 前需要覆盖证据时使用。
---

# E2E Check

把产品改动闭环到可评审的 E2E 证据。spec 名字对得上不等于覆盖到位；契约归属在更窄的层时，
不要加浏览器测试。

从本 `SKILL.md` 解析 `<plugin-root>`。确定性快照与交接助手是
`<plugin-root>/scripts/result.mjs`；绝不在文字里重新实现它的哈希或校验。

## 运行模式

- **`standalone`**：`/check-e2e` 或直接调用。不依赖 `issue-fixer`。
  除非调用方给出绝对输出路径，否则持久化到
  `<repo-parent>/.e2e-check-artifacts/<runId>/e2e-result.json`。
- **`composed`**：由 `issue-fixer` 调用。要求它的 `issueId`、精确的问题 `fingerprint`、
  以及绝对的 `<runDir>/e2e-result.json` 输出路径。把这些值绑在 `consumer` 下；此处绝不
  读 tracker、建 MR、发报告或做回写。

## 输入

要求目标仓库 checkout 绝对路径、对比 ref、当前分支与真实 diff，以及任何已知的问题指纹、
已批方案、路由或复现步骤。standalone 调用可以缺问题上下文，但绝不能缺对比点或 diff 范围。
对比点缺失或 diff 混有无关用户改动时，问清楚哪些改动在范围内。工作区改动也属于本次改动时，
绝不只审计最后一个 commit。

分析前先跑 `node <plugin-root>/scripts/result.mjs snapshot <repo> <comparison-ref>`。把它的
`comparisonPoint`、`changedFiles`、`diffHash` 当权威；哈希涵盖已提交、已暂存、未暂存与未
跟踪内容。不要只用 `git diff` 输出作为持久化身份。

若输出文件已存在，用 `result.mjs read` 带预期模式（composed 模式还带 issue ID 与指纹）
读取。仅当新快照的 `diffHash` 相同时才复用已完成结果。blocked 结果从它记录的 blocker 处
恢复。不匹配意味着结果已过期：重跑审计并原子替换；绝不把旧的覆盖证据合并进新 diff。
`read` 返回完整校验后的模型加新计算的回执字段，所以 blocker/手动提示恢复与完整性交接都用
同一份输出；两者都不要自行重建。

## 1. 建立当前仓库事实

读根目录与最近的 `AGENTS.md`，再读归属包的 `package.json`/构建配置、测试配置、E2E
README、fixtures、helpers、活跃 spec、skip/fixme 条件、CI 入口。

依赖 `docs/` 里的路径文档（用户路径树、页面地图）前先跑 `git ls-files`；未跟踪或缺失的
文档不是当前分支证据。检查从对比点到 `HEAD`、index、工作区及相关未跟踪文件的真实 diff。
排除生成的报告与截图产物，但不排除产品测试或 fixture 改动。

## 2. 推导受影响的用户路径

对每个改动的行为，沿路由归属、调用方、可见文本/角色、状态流转、服务请求、协议边界追下去，
直到指认出用户可观察的路径。改动的文件本身只是风险信号，不是路径。

每个可观察结果写一条契约：

```text
prerequisite | entry | action | observable result | diagnostic signal
```

成功、失败、恢复、权限、持久化、provider/后端变体呈现不同结果时分开记录。若 diff 纯内部，
说明为什么没有用户路径变化，并指出仍被覆盖的稳定外部契约。

由受影响路径构建 `manualTestPrompt`。给出具体前置条件、编号步骤、预期结果、失败时要带回的
证据。用源码里的真实 UI 文案、路由、状态；不要编造 selector、账号、feature flag 或环境
lane。

立即把 `manualTestPrompt` 作为非阻塞的 assistant 更新发出来，然后自动继续覆盖审计。
此处不要用 AskUserQuestion 或等用户；他们可以在步骤 3–6 跑的同时测试，异步汇报结果。

## 3. 选最窄的 E2E 归属

调用每个首选 harness/skill 前先确认它可发现。wrapper 不存在时，用当前仓库配置与文档命令
跑同一 harness。

归属判定是仓库特定的——从仓库事实推导，而不是套固定表：

| 改动的契约 | 归属线索 |
|---|---|
| Web 产品用户路径 | 前端包的 e2e 目录（`e2e/`、`tests/e2e/`、`playwright.config.*` 所在包） |
| 可复用 UI 组件库 | 组件库包的 e2e/visual 套件 |
| 服务端/协议生命周期 | 服务端包的 e2e/integration 目录与其 runner |
| SDK / 客户端协议流 | SDK 包的 e2e/contract 测试 |
| provider/运行时特有行为 | 归属该 provider 的 E2E 工程与包命令 |

优先最近的活跃 spec 及其 fixtures/helpers。只有真实集成边界风险才把跨层冒烟放在归属测试
之上。不要把通用产品流程拷进 provider/adapter 套件。仓库没有 E2E harness 时把该事实记入
ledger（`blocked` + 缺失的 harness），不要造一个不维护的。

## 4. 审计断言级覆盖

按路由、源码符号、无障碍标签、请求/通知、状态流转搜索。分类前读完每个可疑 spec 的完整
arrange、action、assert。只访问路径而没断言改动的可观察结果，只算 partial 覆盖。

每条行为契约记一行 gap 台账：

| path | source + spec evidence | status | missing assertion or harness | owner | command |
|---|---|---|---|---|---|

status 只用：`covered | partial | missing | skipped | blocked`。skip 要绑定其真实 tag 或
环境条件，并区分产品缺陷与 harness 缺口。

返回一个决策：`needs-e2e | update-e2e | no-new-e2e`。`no-new-e2e` 要引用精确的测试与断言，
或给出 E2E 无增量信号的具体原因。纯样式改动通常靠视觉/手动证据，除非它改变了交互、无障碍、
响应式行为，或是 E2E 能稳定观察的回归。

## 5. 关闭每个可行动缺口

`needs-e2e` 或 `update-e2e` 时，返回前实现每个缺失或 partial 的回归。完整遵循所选 E2E
skill/harness 约定，结构照抄最近的活跃 spec。

- 复用当前 fixtures：登录、数据预置、状态准备、诊断。
- 优先 role + 可访问名，其次稳定文本/test id，CSS 仅兜底。
- 一个测试一条行为契约；setup 进 helper，action/assertion 留 spec。
- UI/payload/错误注入用确定性 mock 状态；真实服务只用于真实集成契约。
- 不用 `waitForTimeout`、永久 skip、空断言、加大全局重试、放宽期望来制造通过。
- 稳定实现需要新产品语义、凭据、路由或大规模 harness 扩展时，标 `blocked` 并问一个聚焦
  问题，不要猜。

## 6. 用真实命令验证

跑最小的真实验证阶梯并保留每条结果：

1. 归属 runner 的 `--list` 或等价发现命令；
2. 目标 spec/flow，用最窄支持的环境组合；
3. 改动的 fixture/helper 单测及相关目录套件（适用时）；
4. 共享 E2E 基础设施或配置变化时的包 lint/typecheck/build。

环境阻塞的命令绝不报 passed。要带上首个失败、产物/日志位置、替代检查、以及恢复所需的确切
环境或凭据。命令按时间顺序记录，包括预期失败的复现及其后的通过验证。已解决的早期失败是
证据；返回非阻塞结果前，最终目标验证必须是 `pass`。

CI 提供失败证据时，从失败的 pipeline/job/step、脱敏签名、首个仓库帧诊断稳定失败簇。缺失
日志或覆盖缺口保持显式；不要猜产品根因。

## 输出

所有产品/E2E 编辑完成后，再跑一次 `result.mjs snapshot`，让持久化哈希描述最终 diff（含新增
spec 与 fixture）。构建这个带版本的结果模型：

```yaml
schemaVersion: issue-fixer-e2e/v1
mode: standalone | composed
status: completed | blocked
runId: string
repository: /absolute/repo
comparisonPoint: string
branch: string
diffHash: string
changedFiles: [string]
paths:
  - { id: string, prerequisite: string, entry: string, actions: [string], expected: string, diagnosticSignal: string }
manualTestPrompt:
  prerequisite: string
  steps: [string]
  expected: [string]
  failureEvidence: [string]
decision: needs-e2e | update-e2e | no-new-e2e
ledger:
  - { path: string, evidence: [string], status: covered | partial | missing | skipped | blocked, gap: string, owner: string, command: string }
changes: { specs: [string], fixtures: [string], config: [string] }
commands: [{ command: string, result: pass | fail | blocked }]
blockers: [{ reason: string, resumeWith: string }]
consumer: not-applicable | { plugin: issue-fixer, issueId: string, fingerprint: string }
```

还有可行动的 `partial` 或 `missing` 行时不得返回。`blocked` 行要求最小的具体解锁请求，
且必须在结果中保持可见。最终结果里再次展示 `manualTestPrompt` 连同收到的任何回复。记录
`passed | failed | blocked | deferred | pending`，但不要把手动测试变成新的强制门禁。

原子写入模型：

```text
node <plugin-root>/scripts/result.mjs write <model.json> <e2e-result.json> \
  --mode <standalone|composed> [--issue-id <issue-id> --fingerprint <issue-fingerprint>] \
  --diff-hash <final-diff-hash>
```

把助手回执（`resultPath`、`schemaVersion`、`sha256`、`status`、`decision`、`diffHash`、
以及 composed 的 consumer 绑定）作为交接返回。blocked 的运行即使没建任何 spec 也会被
持久化、可恢复；只有 `completed` 要求：必需的 E2E 改动完成、无可行动缺口、无 blocker、
最终命令通过。
