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
| notify | `deliverFixNotification(model)` | `stdout`、`lark`（connector → lark-cli DM/群卡片回退；openId 缺省自动 whoami、支持姓名/邮箱经 contact 解析、chatId 发群；scratch 只发操作者）、`cognia`（宿主 `connector_send` markdown 片段入绑定会话） |
| host | `cogniaApiCall(verb,args)`、`cogniaApiDescribe(verb)`、`cogniaHostStatus(cfg)` | `none`、`cognia`——共享宿主命令平面（bots/tasks/workflows/connector_send）；bin/session 解析集中一处；notify/progress 是它的消费者，`integrations/cognia/` 放 bot 定义与安装草案 |
| cognia 打包 | `scripts/build-cognia.mjs` | 每个插件目录同时是合法 Cognia 插件：根 `plugin.json`（`type: frontend`，capabilities `skills`+`command-hooks`）+ `dist/index.js`（module manifest 与打包 manifest 同构，过宿主 parity 检查）。产物由规范转换器（`plugin-convert`/托管 `cognia` CLI 的 `plugin import`）生成并提交；skills→`local-bundle`、commands→inline prompt skills、hooks.json→`commandHooks`；同名 bundle/inline 冲突时保留 bundle |
| evidence | `extractLarkLinks / collectLarkEvidence(texts, outDir)` | 输入与记录字段里的飞书链接统一取回：docx/wiki → markdown、minutes → 摘要+逐字稿、om_ 消息 → 正文+附件；sheets/file 标 manual |
| report | `build(model) → md`、`publish(md, title) → url` | `markdown`（落盘）、`lark-docx`、`custom` |
| capture | `shot(url, out, …)`、`compare(before, after)` | 本地 Playwright；`local-dev`/`real-env` 由配置驱动 |
| deploy | `deploy({branch, env, targets})` | 空 = `not-applicable`；`deployCommand`/`envFindCommand` 模板 |

新增适配器 = 在对应 `lib/*.mjs` 的 switch 里加一个 case + 配置字段；orchestrator
与 skills 不用动。

## 流水线契约

三段不可协商的门禁（对应 AGENTS.md）：① 指纹+档+复现+根因+定位+结局+方案；
② 用户测试+推送/MR/PR（推送在批准之后）；③ tracker 回写+通知（仅 tracker-record）。
门禁之外的动作不擅自做。门禁卡片的内容与选项固定在
`skills/issue-orchestrator/references/gates.md`。

规范步骤表（21 步，`lib/runstate.mjs` 的 `STEPS` 是唯一事实源，SKILL.md 的步骤表由
契约测试比对）：取证 → 分诊定档 → 复现 → 定位 → 🚦① → 隔离 → 基线 → 红灯 → 改码 →
验证 → 证据 → E2E → 复核 → 提交 → 🚦② → 推送+MR → CI → 报告 → 🚦③ → 回写+通知 →
完成审计。

五个运行坐标各管一件事，互不替代：

| 坐标 | 决定 |
|---|---|
| 模式（tracker-record / direct-evidence） | tracker 段是否适用 |
| 分类（ui / runtime-error / backend / data / performance / config / security） | 定位方法与证据形态 |
| 规模档（S / M / L / XL） | 每步最低深度、复核方式、熔断预算；**不删步骤** |
| 改动面（样式文案 / 逻辑 / 用户可见协议 / 性能） | 验证档位 |
| 结局（fixed / already-fixed / cannot-reproduce / not-a-bug / duplicate / needs-decision / external / escalated / split / abandoned） | 哪些步骤适用、修改报告还是调查报告 |

步骤不适用只有四种来源：模式与结局（`notApplicableSteps` 规则推导）、门禁答复（Gate ②
`keep-local`、Gate ③ `declined`，由 `GATE_DECISIONS` 在同一次写入里标出）、能力缺失（手工
标注且必须带原因）。把"小改动"做成跳步会让证据链断在最容易出错的地方（没有红灯的修复
无法证明修到了），所以档只调深度。

证据推翻已完成步骤时用 `reopen <step>` 回退：该步及其后全部回到 pending、artifacts 保留
（外向产物原地更新）、被回退的门禁进入新一轮——门禁 id 带轮次，上一轮的答复与迟到的 HIL
提交不再算数。Gate ① 批准后改档或改结局会被拒绝，必须先 reopen，保证"升档/结局变化即
重过 Gate ①"不靠 agent 自觉。无改动结局是一等
公民：`report.mjs` 为它们构建调查报告并校验每种结局的必需证据。

运行状态显式建模：`pending|running|done|blocked|failed|not-applicable`，
可恢复——"继续"= 重新校验输入后从第一个未完成步骤恢复，绝不重复已完成的
外部动作（认领/MR/报告/回写/通知）。落盘为 `<runDir>/run-state.json`
（`lib/runstate.mjs`，原子写，带 CLI——agent 不手写 JSON；进度块由运行状态生成，
状态词折成桥的词表）；门禁答案带派生 id `gate:<sha256(runId|gate)>`，
重入命中已记录答案而不再提问（借鉴 Cognia bot runtime 的
`bot-approval:<sha256>` interrupt 派生）。部署态门禁用 `hil_form_schema`
卡片（`publishGateFormViaConnector`），submit/cancel 经 `plugin_event_publish`
回写同一派生 id。

## 业内借鉴

各机制对应的业内做法，改动时用来判断是否偏离原意（表中的 `sizing.md`、`diagnosis.md`、
`outcomes.md`、`situations.md` 位于 `plugins/issue-fixer/skills/issue-orchestrator/references/`）：

| 来源 | 做法 | 在本流水线的落点 |
|---|---|---|
| SWE-bench 评测协议 | 修复以两组测试判定：原本失败、修复后必须通过的 FAIL_TO_PASS；原本通过、修复后仍须通过的 PASS_TO_PASS | `red` → `fix` 的红灯→绿灯，加上"原来过的仍然过"的受影响测试集（diagnosis.md §5） |
| Agentless（Xia 等） | 分层定位：文件 → 类/函数 → 编辑位置；生成复现测试筛选补丁；用回归测试排除破坏性补丁 | 分层定位（diagnosis.md §2）、复现先于修复、验证对照基线 |
| SWE-agent（ACI） | 为 agent 设计的工具接口；编辑后立即 lint，拒绝语法错误的改动 | 每次编辑后在 worktree 内跑最窄检查；脚本输出结构化、可分支的结果 |
| Claude Code 最佳实践 | 探索 → 计划 → 编码 → 提交；测试先行；用独立子代理核查，避免自我确认 | Gate ① 前只读探索与计划、`red` 先写失败测试、`review` 用独立上下文 `bugfix-review` |
| GitHub Copilot coding agent | 在独立分支工作、开 Draft PR、按评审评论迭代、不直接推默认分支 | 隔离 worktree、Draft MR/PR、评审意见走 `claim-verify-first` 再改 |
| Bugzilla / Mozilla 分诊 | 严重度 S1–S4 与优先级分离（本流水线记作 sev1–sev4，避免与档 S 混淆）；needinfo 向指定人要信息；结局 FIXED / DUPLICATE / WORKSFORME / INVALID / WONTFIX / INCOMPLETE | 档与严重度分离（sizing.md）、单问 needInfo、结局表（outcomes.md） |
| Chromium 回归处理 | 用 bisect 给出回归区间，标注引入变更 | 回归时找引入提交、有界 `bisect run`（diagnosis.md §3） |
| Kepner-Tregoe 问题分析 | IS / IS NOT 对照找差异，从差异推原因 | 无法复现时的 IS / IS NOT 表（diagnosis.md §1） |
| 科学调试法（Zeller《Why Programs Fail》） | 假设 → 预测 → 实验 → 观察 → 结论，逐条记录 | 假设日志 `hypotheses.md` 与熔断计数 |
| Google SRE 事后复盘 | 对事不对人的根因分析，行动项跟踪到底 | 因果链、"为什么现在"、followUps |
| Google 工程实践：小 CL | 一次改动只做一件事，便于评审与回滚 | 范围纪律、同类缺陷只记录不顺手改、`split` |
| 协调披露（SECURITY.md 惯例） | 漏洞修复不在公开渠道提前暴露利用细节 | 安全类的最小披露规则（situations.md） |

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
