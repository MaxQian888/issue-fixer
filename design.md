# 设计：通用 issue 修复流水线

本仓库是把一个深度绑定单一产品（固定 tracker、固定 forge、固定部署通道、固定
base 分支）的修复工作流，泛化成「核心流水线 + 可换适配器」的实现。

## 原则

1. **流水线不知道目标是谁。** orchestrator 只讲步骤、门禁与证据契约；tracker、
   forge、通知、报告、部署全是配置驱动的适配器。
2. **没有假成功。** 适配器做不到的事返回 `pending`/`blocked`/`not-applicable`
   和恢复指令，绝不假装完成。
3. **scratch 优先。** 默认 `target=scratch`：一切 tracker 写操作打到 scratch 表，
   不通知真实提出人。写生产必须显式 `target=real`。
4. **direct-evidence 是一等公民。** 用户直接给的证据不需要 tracker 记录；
   整条流水线的 tracker 段自动 `not-applicable`。
5. **证据 > 声明。** before/after 截图有严格契约（同路由/视口/状态/修订），E2E
   交接有版本化 schema + SHA-256 + diffHash 校验，报告构建前校验全部输入。

## 适配器面

`scripts/lib/config.mjs` 解析配置（defaults < fixer.config.json < FIXER_* env <
调用方 overrides），各适配器按 `type` 分发：

| 面 | 接口 | 内置实现 |
|---|---|---|
| tracker | `resolveRecordId / getRecord / listByStatus / listByView / claim / updateRecord / downloadAttachments / uploadAttachment / recordUrl`；可选 `preflight()`、`reporterOf(record)`、`initScratch()` | `none`（仅 direct-evidence）、`lark-base`（含 scratch-guard + whoami preflight + 提出人解析 + `init-scratch` 一键建表） |
| forge | `createMR({head, base, title, bodyFile, draft, cwd})`、`findExisting(head)`、可选 `checks(head)` | `git`（推送指令 + pending）、`github`（gh pr create/edit + `gh pr checks`，repo 自动从 origin 解析）、`custom`（命令模板） |
| notify | `deliverFixNotification(model)` | `stdout`、`lark`（connector → lark-cli DM/群卡片回退；openId 缺省自动 whoami、支持姓名/邮箱经 contact 解析、chatId 发群；scratch 只发操作者）、`cognia`（复用宿主 bot 设施：`api call connector_send` markdown 片段入绑定会话） |
| evidence | `extractLarkLinks / collectLarkEvidence(texts, outDir)` | 输入与记录字段里的飞书链接统一取回：docx/wiki → markdown、minutes → 摘要+逐字稿、om_ 消息 → 正文+附件；sheets/file 标 manual |
| report | `build(model) → md`、`publish(md, title) → url` | `markdown`（落盘）、`lark-docx`、`custom` |
| capture | `shot(url, out, …)`、`compare(before, after)` | 本地 Playwright；`local-dev`/`real-env` 由配置驱动 |
| deploy | `deploy({branch, env, targets})` | 空 = `not-applicable`；`deployCommand`/`envFindCommand` 模板 |

新增适配器 = 在对应 `lib/*.mjs` 的 switch 里加一个 case + 配置字段；orchestrator
与 skills 不用动。

## 流水线契约

三段不可协商的门禁（对应 AGENTS.md）：① 指纹+定位+方案；② 用户测试+MR/PR；
③ tracker 回写+通知（仅 tracker-record）。门禁之外的动作不擅自做。

运行状态显式建模：`pending|running|done|blocked|failed|not-applicable`，
可恢复——"继续"= 重新校验输入后从第一个未完成步骤恢复，绝不重复已完成的
外部动作（认领/MR/报告/回写/通知）。

## E2E 交接

`e2e-check` 是独立插件，standalone/composed 双模式。结果 schema
`issue-fixer-e2e/v1`：原子写盘，`read` 时校验 issueId + fingerprint + 当前
`diffHash` + SHA-256。diff 或指纹变了 → 只重跑 E2E 阶段，不重启流水线。
主插件绝不把内联文字当 E2E 证据。

## 与原实现的对照

| 原硬编码 | 现在的位置 |
|---|---|
| 固定 Lark Base token/table | `tracker.baseToken/tableId` + `lark-base` 适配器 |
| 固定 `dev` 基线 | `baseBranch`（默认 `main`） |
| 固定主 checkout 路径 | `repoDir`（必填） |
| 固定内部 MR 平台 API | `forge` 适配器（git/github/custom） |
| 固定预发环境通道 | `deploy.deployCommand` 模板；不配则 `not-applicable` |
| 飞书 docx 报告 | `report` 适配器（默认 `markdown`） |
| 固定 Base 字段名 | `tracker.fields` / `tracker.status` 映射 |
| 内部 E2E 交接 schema v1 | `issue-fixer-e2e/v1` |
