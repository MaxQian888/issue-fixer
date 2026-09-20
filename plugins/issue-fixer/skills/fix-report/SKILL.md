---
name: fix-report
description: >-
  把一次完成的修复汇编成修改报告（经 report 适配器发布：markdown 落盘 / 飞书 docx /
  自定义命令），可选把结果回写 tracker 记录并通知提出人。direct-evidence 问题走
  report-only；tracker-record 在 gate ③ 之后走 tracker-writeback。由
  issue-orchestrator 调用，或当用户说"生成修改报告 / 回写记录 / 通知提出人"时使用。
---

# fix-report

把完成的修复变成一份报告，可选 tracker 回写与提出人通知。
使用 `<plugin-root>/scripts/report.mjs`、`scripts/lib/tracker.mjs`、
`scripts/lib/notify.mjs`。

两种调用模式二选一：

- **`report-only`**：只构建并发布报告然后停止。`direct-evidence` 一律用这个。不要调用
  `tracker.mjs` 或 `deliverFixNotification`——没有记录/提出人。
- **`tracker-writeback`**：仅在 orchestrator 为 `tracker-record` 批准 gate ③ 之后；
  用已发布的 `reportUrl` 做记录更新、附件与提出人通知。

绝不隐式混用两种模式。本地修复证据齐了就可以跑 `report-only`；`tracker-writeback` 需要
一份绑定同一问题指纹与报告 URL 的已持久化批准。

## 输入（模型）

`source, issueId, recordId, recordUrl, issueDesc, module, priority, reporterName,
reporterOpenId, locateFile, locateDetail, planSummary, diff, verify, e2eHandoff,
manualTest, beforeAfterNote, compareRef, mrUrl, envUrl, taskUrl, beforePng, afterPng`。
`recordId` 与提出人字段仅 `tracker-writeback` 需要。

构建前校验：

- 始终要求 `source`、`issueId`、`issueDesc`、带行号信息的 `locateFile`、`planSummary`、
  `diff`、`verify`、`e2eHandoff`、`manualTest`、`beforeAfterNote`。
  `e2eHandoff` 必须指向 `e2e-check` 产出的那个绝对路径的完整合成结果，并包含其 schema
  版本、SHA-256 回执、最终 diffHash、issueId、问题指纹。`report.mjs` 会读该文件、校验
  checksum/schema/diff/消费者绑定，并从中推导 `e2eCheck` 与手动测试提示；绝不接受内联的
  覆盖率摘要当事实源。
- 水合后的 E2E 模型必须包含覆盖决策、受影响路径、台账、改动的 spec、真实命令结果、
  blockers；manual test 必须保留用户的 `passed` 或显式 `deferred` 结果与证据。先失败的
  复现尝试及其后的通过验证要保留；`report.mjs` 要求最终 E2E 命令通过，并拒绝无效决策、
  空证据、可行动缺口、blockers、不完整的 manual-test 模型。因为这份报告描述的是用户
  问题，即使决策是 `no-new-e2e` 也要求至少一条受影响/稳定用户路径和一行覆盖台账；
  独立的纯内部审计仍是 E2E 插件的有效输出，但不构成 fixer 报告。
- 报告声称截了图时，要求 `beforePng`、`afterPng` 文件存在。否则写明精确的采集受限原因；
  不要链接不存在的文件。
- `tracker-writeback` 要求 `recordId`、`recordUrl`、`reporterOpenId`、`notifyOpenId`、
  `target`、`reportUrl`。
- `mrUrl`/`envUrl` 缺失仅当有对应 pending 原因与恢复命令时允许。
- 模型、markdown、通知中脱敏 token、cookie、authorization header、私有 storage-state
  内容与原始环境变量 dump。

## 步骤

1. **`report-only`：报告。**
   - `node <root>/scripts/report.mjs build <model.json> report.md`
   - `node <root>/scripts/report.mjs publish report.md "修改报告 · <issueDesc>"` →
     经 `report` 适配器发布（`markdown` 落产物目录返回路径；`lark-docx` 发飞书文档；
     `custom` 走 `report.publishCommand`）。
   - 把返回的 URL/路径记为 `reportUrl`。

   仅当发布返回确认的结果（URL/token/路径）才算发布成功，存入运行状态。模糊超时后重试
   前，尽可能先查已创建的同名产物以免重复。

   - `direct-evidence` 到此结束，返回 `reportUrl`；tracker 回写与通知为 `not-applicable`。

2. **`tracker-writeback`：回写（🚦 gate ③ 已由 orchestrator 批准）。** 经 tracker
   适配器的 scratch 护栏：
   - `tracker.updateRecord(recordId, { <statusField>:<status.done>,
     <noteTextField>:'<摘要> · MR:<mrUrl> · 报告:<reportUrl>',
     <followerField>:[<操作者/机器人 id>] })`（字段名取 `tracker.fields` 配置）。
   - `tracker.uploadAttachment(recordId, <noteField 或其 fieldId>, [beforePng, afterPng])`
   - `scratch` 模式下这些打到配置的 scratch 表，绝不打生产 tracker。未配置 scratch 表时
     写入被拒绝——摆出缺口，不绕过。

3. **`tracker-writeback`：通知。** `deliverFixNotification(model)`（notify 适配器）。
   `lark` 类型在部署运行时经 connector 发布 `plugin/event/publish`（raw_card）→ 消息桥
   （仅 **real** 模式下 `mention` = 提出人 open_id）；本地回退 `lark-cli im` 发给
   `notifyOpenId`（scratch 模式 = 操作者本人；绝不发给真实提出人）。`notifyOpenId`
   缺省时自动用 `lark-cli whoami` 的操作者 open_id 兜底——本地 scratch 场景零配置即可
   收到卡片。配置了 `notify.chatId`（`oc_…`）时改为发群卡片；`notify.openId` 允许
   姓名/邮箱，非 `ou_` 值自动经 `lark-cli contact +search-user` 解析，多人命中时
   要求精确 open_id。`stdout` 类型打印通知正文。`cognia` 类型复用宿主 bot 设施——
   `cognia-agent api call connector_send` 把 markdown 片段投递到会话绑定的会话
   （治理出站通道），会话 id 由 `notify.cogniaSessionId`/`FIXER_/COGNIA_SESSION_ID`
   提供，CLI 依次找 `notify.cogniaBin`→PATH→`<repoDir>/cli/dist/cognia-agent.mjs`。
   模型带 `title, notifyOpenId, reporterOpenId, target` 及 MR/环境/报告/记录链接。

   仅当后端返回确认的事件/消息结果才算通知完成。渲染出的卡片 JSON 或 connector 命令不是
   送达证据。

## 注意

- 对 tracker 记录，报告图片可放在记录备注附件里，报告可链接到记录。对 direct evidence，
  嵌入或链接所提供/before-after 产物，不编造 tracker URL。二进制媒体嵌进文档是加分项，
  非必需。
- 若 `mrUrl`/`envUrl` 处于 pending（forge/deploy 未配置或不可用），写成
  "MR 待创建（命令见报告）"而不是省略——报告要诚实区分"已跑"与"需要部署环境"。

## 输出契约

```yaml
mode: report-only | tracker-writeback
report: { url: string, token: string, markdown: string }
writeback: { status: done | blocked | not-applicable, recordId: string, fields: {} }
attachments: { status: done | blocked | not-applicable, files: [] }
notification: { status: done | blocked | not-applicable, backend: connector | lark-cli | cognia | stdout, messageId: string }
blockers: [{ step: string, reason: string, resumeWith: string }]
```

`not-applicable` 只用于模式本身排除的操作。writeback、附件上传、通知的 `blocked`
各自独立保留，一个失败不掩盖其他。
