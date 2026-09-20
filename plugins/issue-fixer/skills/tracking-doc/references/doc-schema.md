# 埋点文档结构 + CSV 规则

> 生成产物前读本文。Markdown 是主交付物；CSV 仅在知道目标平台列结构时生成。

## Markdown 结构（`<scope>-tracking-design.md`）

```
# <scope> 埋点设计

## 0. 基本信息
| 项 | 值 |
|---|---|
| 扫描范围 | <目录/包> |
| 扫描时间 | <YYYY-MM-DD> |
| 事件总数 | reported N / declared-only M |
| 扫描器 | scan-tracking.mjs（patterns 见附录） |
| 公共参数 | <SDK/框架自动注入的维度，列一次不重复写> |

## 1. 事件模型
<物理 event vs 逻辑子事件的传输模型：单 event 多逻辑值？每个逻辑值独立 event？
附 discriminator 字段名与取值枚举。>

## 2. 事件总览
| 物理 event | 逻辑子事件 | 中文描述 | 触发时机 | 状态 | 证据 |
|---|---|---|---|---|---|
| <event> | <name 值或 —> | <做什么> | <什么条件下> | reported / declared-only | file:line |

## 3. 逐事件详情
### <event>（<逻辑子事件>）
- **触发时机**：<谁在什么条件下触发；success-only / failure-only / 采样 / 环境限制>
- **业务参数**：| 参数 | 类型(代码) | 类型(登记) | 必传 | 取值/枚举 | 说明 |
- **证据**：<file:line 列表>
- **风险**：<类型不符 / 动态字段 / 条件存疑等，无则写「无」>

## 4. 参数字典
| 参数 | 代码类型 | 出现的事件 | 取值约束 |
（跨事件复用参数的字典化，防同参数多义）

## 5. 声明未上报
| event | 声明位置 | 建议 |
（declared-only：待清理 or 待补上报——每条给处置建议）

## 6. 候选埋点（仅 --candidates）
| 位置 | 推断的交互 | 优先级建议 |
（启发式线索，必须标注「候选」，不得写成确定缺口）

## 7. 规范风险
<类型不符 / 高基数维度 / 命名不一致 / 敏感字段未脱敏——保留真实值并标风险，不静默修正>

## 8. 待确认
<扫描器静态分析无法确认的内容；每条给需要谁确认什么>

## 9. 扫描证据
<命令行、文件计数、patterns、排除规则——可复跑的完整凭据>

## 附录 A. JourneyCard（输入来自 E2E/CUJ 时）
<保留前置状态、入口、动作、结果、失败分支、源码/spec 证据>

## 附录 B. TrackingCoverageCard（同上）
| 分析问题 | 现有事件/信号 | 状态 | 候选动作 |
（状态只用 existing-sufficient / existing-partial / candidate-missing /
not-recommended / unknown）
```

## CSV 规则（`<scope>-events.csv`，可选）

- 列结构默认：`event,description,param,param_type,required,trigger`；
  目标平台有固定导入模板时用 `analytics.csvColumns` 覆盖——**列头逐字抄模板**，
  不知道模板就只出 Markdown。
- RFC 4180 转义（逗号/引号/换行进引号），保留空单元格，不加模板辅助行。
- 每个 event 至少一行物理 event 行（param 留空）；每个 param 一行。
- 未知字段留空并进 Markdown「待确认」，不虚构。
- 存在未解决物理 event / 非法参数类型 / 动态字段时，文件名或表头注释标
  「草稿-不可直接导入」。
