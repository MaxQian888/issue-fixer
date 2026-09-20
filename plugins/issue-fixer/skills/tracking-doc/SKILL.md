---
name: tracking-doc
description: >-
  扫描代码盘点埋点/事件上报，生成中文埋点设计 Markdown 与可选 CSV 清单。解析 wrapper、
  物理事件 vs 逻辑事件、schema/常量、参数、时机、仅声明未上报事件、以及可选的未埋点候选。
  用于 找/盘点/扫描/整理/审计埋点、从 E2E/CUJ 补埋点建议、埋点设计文档、或某
  codebase/package/页面/组件的埋点覆盖。事件调用约定由 fixer.config.json 的
  `analytics.patterns` 配置；不内置任何平台私有 API。
---

# 埋点代码盘点与文档生成

从代码事实反向生成埋点资产。默认交付：

1. `<scope>-tracking-design.md`：供产品、研发、QA 评审；
2. `<scope>-events.csv`（可选）：一行一个 `event × param`，列结构由 `analytics.csvColumns` 或默认列决定；
3. 结果摘要：扫描范围、事件数量、声明未上报、规范风险、待人工确认项。

只生成或更新用户要求的文件。默认只做代码扫描；不注册/修改任何平台侧资源、不修改业务埋点代码或操作 git，除非用户另行授权。

## 工作流

为以下每一步建立 todo，并在完成前保留证据。

### 1. 确定范围与仓库事实

- 读取目标目录适用的 `AGENTS.md`、README 和已有埋点文档。
- 明确扫描类型：整包盘点或页面/组件聚焦扫描。用户给出路径时直接采用；仅说"项目埋点"时，先定位应用源码与 package root。
- 检查现有 source of truth：SDK wrapper、事件 enum/constants、schema registry、param builder、已有清单或覆盖工具。存在时复用其术语和边界。
- 在 monorepo 中按 package/端分别扫描，禁止把前端逻辑子事件和服务端物理事件混成一个目录。
- 输入来自 E2E、CUJ、用户路径或 gap ledger 时，先保留其前置状态、入口、动作、结果、失败分支和源码证据——测试步骤本身不是埋点需求。

仅当范围存在多个会显著改变产物的合理解释且无法从仓库推断时，才询问用户。

### 2. 扫描代码

```bash
node <plugin-root>/scripts/scan-tracking.mjs <targetPath...> --root <packageRoot>
```

聚焦扫描时，把目标文件/目录与位于范围外的 enum/schema/wrapper 文件一并作为
`targetPath`，否则无法证明完整的事件身份和参数契约。仅在用户要求"查漏、覆盖率、
哪些交互没埋点"时增加 `--candidates`。

读取并保留这些字段的含义：

- `eventCatalog[].event`：调用点第一个字符串参数解析出的事件身份；
- `eventCatalog[].status`：`reported`（至少一个 report site）或 `declared-only`；
- `sites[].kind`：`report` 是上报证据，`declaration` 只是声明证据；
- `declaredButUnfired`、`candidates`：分别作为待清理、人工评审线索处理。

扫描器只负责定位，不负责理解业务语义。不得把扫描 JSON 原样当作最终文档。
默认模式覆盖常见 `track(`/`capture(`/`analytics.*(`/`report(` 调用——目标仓库用自定义
wrapper（如 `logEvent`、`sendBeacon` 封装）时在 `fixer.config.json` 的
`analytics.patterns` 里补正则，用 `analytics.exclude` 排除噪声路径。

### 3. 建立事件身份与证据

对每个事件先回答三个问题：

1. **物理 event 是什么？** 最终送往上报通道的 event 名（往 CSV/文档的 event 列写它）。
2. **是否存在逻辑子事件？** 例如 `track('app_event', { name, ...params })` 中，
   `app_event` 是物理 event，`name` 的枚举值是逻辑子事件。
3. **是否真的上报？** 至少需要一个 `report` site；enum/schema 中存在只能标记为
   `declared-only`，不能写成"已上报"。

单物理事件模式下：

- Markdown 按逻辑子事件描述触发时机和业务参数；
- CSV/清单的 `event` 始终填写物理 event；
- 用 discriminator 参数及场景标定条件（如 `name=create_branch`）表达逻辑场景；
- 不得把逻辑枚举值伪装成独立物理 event。

### 4. 解析触发时机与参数

逐个打开所有 `report` site 及其上游条件、异步成功/失败分支、wrapper 和参数来源：

- 从调用上下文写清"谁在什么条件下触发"，注明 success-only、failure-only、采样、
  环境或权限限制；
- 以 schema/typed builder 为参数名称、代码类型和可选性的优先来源，再用调用点确认
  实际值与枚举；
- 区分业务参数与 SDK/service 自动注入的公共参数；公共参数在基本信息中说明，
  不重复成每个逻辑事件的业务参数；
- 解析 spread、helper、动态 key 和 auto-track 标记；无法静态确认的内容进入"待确认"，
  不得猜测。

同时记录**代码实际类型**与**清单登记类型**。登记侧若只接受有限类型集（如
`integer|string|float`），代码实际上报 boolean/object/array 时不得直接改写成兼容
类型并声称兼容——保留真实类型、标为阻断风险，并提出序列化或 schema 调整建议。

### 5. 可选：E2E 用户路径与埋点覆盖对齐

输入含 JourneyCard、CUJ、用户路径或 E2E gap ledger 时：

1. 保留 E2E 的前置状态、入口、动作、结果、失败分支和源码/spec 证据。
2. 对采用、转化、失败、耗时、恢复问题逐项映射现有代码事件与平台信号。
3. 输出 `TrackingCoverageCard`，状态只用 `existing-sufficient`、`existing-partial`、
   `candidate-missing`、`not-recommended`、`unknown`。
4. 每条增强/新增候选写明唯一 owner、业务时机、稳定维度、隐私限制和推荐测试层；
   最多保留 3 个高价值候选。
5. 未经用户授权，只提示和交接，不修改埋点代码或 E2E。

### 6. 生成 Markdown 与 CSV

Markdown 必须包含：基本信息、事件模型、事件总览、逐事件详情、参数字典、
声明未上报、候选项、规范风险、待确认、扫描证据。输入来自 E2E 时还必须包含
JourneyCard 与 TrackingCoverageCard。详细结构见 `references/doc-schema.md`。

CSV 可选：默认列 `event,description,param,param_type,required,trigger`。目标平台有
固定导入模板时，把列头配置进 `analytics.csvColumns` 再生成——不知道模板就只出
Markdown，不编造就绪状态。

- 每个清单 event 至少有真实物理 event、中文描述、埋点类型；有 param 时必须同时填写
  名称、描述、类型和是否必传；
- 未知负责人、业务线、需求链接等字段留空并列入待确认，不得虚构；
- 存在未解决的物理 event、非法参数类型或动态字段时，将 CSV 标记为"草稿/不可直接
  导入"，不要宣称 ready。

默认把产物放在目标 package 的 `docs/tracking/`；若仓库已有埋点文档目录或用户指定
位置，沿用已有位置。文件名使用小写 kebab-case，文档正文使用中文。

### 7. 可选：平台与运行数据对齐

当用户要求完整性、覆盖率、线上对齐、失效埋点、看板一致性或治理审计时：

1. 用目标平台**已配置的只读查询通道**（仓库自有 CLI / API 工具，如平台查询命令）
   查注册表、元数据、看板引用；任何鉴权/权限/超时失败都记为 `unknown`。
2. 输出 gap ledger：代码扫到但平台未注册、平台有但代码已删、两边都在但参数漂移——
   区分确定 mismatch、候选项和未检查项。
3. 看板引用不证明代码仍上报，查询为 0 也不证明事件已失效——只对齐，不编造因果。

此分支只读。用户只要求生成文档时不主动扩大到平台查询。

### 8. 验证产物

逐项检查：

- 每个 `reported` 事件在 Markdown 中恰好有一个逻辑条目，并有至少一个 `file:line`
  上报证据；
- 每个 `declared-only` 事件只出现在声明未上报/待确认区域，不混入已上报统计；
- Markdown 与 CSV 的物理 event、逻辑 discriminator、参数必传性和类型一致；
- 每个必传参数都有非空约束或明确风险；每个枚举参数有可审查的取值说明；
- candidates 明确标注"启发式候选"，没有写成确定缺口；
- 重新运行扫描器，确认事件计数与最终文档一致。
- 执行平台对齐时，gap ledger 中每一列都有命令或文件证据；鉴权/权限失败没有被
  写成 missing。
- E2E 组合分支中，每个埋点候选都关联明确分析问题和 JourneyCard；未把 selector、
  每次点击或原始错误直接当作 event/param。

### 9. 交付后续动作

只报告与本次结果相关的后续步骤：平台登记（导入清单、补齐业务线和负责人、审核
上线）、QA 实时验证方式、数据分析/看板交接给当前会话实际可用的分析能力。不要引用
当前会话不存在的 skill 当作已可用工具；可说明缺失能力，但不要假设已安装。

## 不可妥协的规则

- **证据优先**：每个结论追溯到声明或上报代码；未知即待确认。
- **物理与逻辑分离**：清单 event 永远以 SDK 最终上报的物理 event 为准。
- **声明不等于上报**：catalog/schema/enum 不能替代 report site。
- **代码事实不静默修正**：规范违规保留真实值并显式标风险。
- **候选不等于缺口**：`--candidates` 只产生人工评审线索。
- **尊重仓库边界**：排除生成物、依赖和测试（除非指定），不扫描或修改不在用户
  范围内的模块。

## 参考文件

- `references/doc-schema.md` — Markdown 产物结构 + CSV 规则。
