# 门禁卡片

三个门禁各有一张固定结构的卡片：先在 assistant 正文里完整展示卡片，再用运行时的原生
提问能力（本地 AskUserQuestion；部署态 `publishGateFormViaConnector` 的 HIL 表单，
`requestId` 与选项取 `runstate.mjs gate-id <runDir> <gate>`）问**一个**问题，选项用下面
给出的。答案经
`node <root>/scripts/lib/runstate.mjs gate <runDir> <gate1|gate2|gate3> <decision> --summary "<用户原话或要点>"`
落盘（部署态 HIL 回传时加 `--request-id <表单的 requestId>`，上一轮的表单答复会被拒绝）。
CLI 只接受下表的答复值（外加通用的 `rejected` = 暂停在 `blocked`），并在同一次写入里完成
它的副作用——回退、随之不适用的步骤、结局、手测结果——不需要再手动补标。CLI 同时拒绝：
不适用的门禁、没轮到的门禁（恢复点不是它）、档与结局还没 `meta` 就批准 Gate ①；门禁步骤
也不能用 `set` 直接改状态。

| 门禁 | 答复 | 门禁状态 | 同时发生 |
|---|---|---|---|
| ① | `approved` | done | — |
| ① | `changes-requested` | 回到 pending（新一轮） | `reopen locate`：改方案、重新定位、或选定 XL 的某个切片 |
| ① | `need-info` | blocked | waitingFor = summary |
| ① | `abandon` | done | 结局 `abandoned` |
| ② | `approved` | done | 手测 `passed` |
| ② | `approved-deferred` | done | 手测 `deferred` |
| ② | `failed` | 回到 pending（新一轮） | 手测 `failed`；`reopen fix` |
| ② | `push-only` | blocked | waitingFor = 预览测试结果 |
| ② | `keep-local` | done | `publish`、`ci` 不适用 |
| ③ | `approved` | done | — |
| ③ | `writeback-only` | done | 回写但不通知 |
| ③ | `changes-requested` | blocked | waitingFor = 要改的内容 |
| ③ | `declined` | done | `writeback` 不适用 |

重入时先 `runstate.mjs show`：该门禁本轮已 `done` 就不再问；被 `reopen` 回退过的门禁是
新一轮，必须重新展示卡片并提问。门禁卡片里任何一项拿不出来，就说明缺什么、为什么缺，
不留空、不编造。

## Gate ① · 方案

**卡片**（S 档可压成一段，但每一项都要有）：

1. **指纹**：`fingerprint` + 来源 + 原文描述（逐字）+ 已知的模块/优先级 + 证据清单
   （截图/日志/记录 id）。
2. **判定**：分类 · 档（附命中的判档信号；重开的门禁附 `tierHistory`）· 改动面 · 严重度
   （`sev1..sev4`，推断的标 inferred）。
3. **复现**：`repro.status` + 方法 + 观察到的症状；未复现就给 IS / IS NOT 表。
4. **根因**：因果链；M/L 档加"为什么现在"（引入提交或"未找到"）。
5. **定位**：`file:line` + 锚点 + 置信度 + 未验证项；备选位置（至多两个）。
6. **结局提议**：`fixed`（附 `fixKind`）或某个无改动结局及其证据。
7. **方案**（结局为 `fixed` 时）：最小改动描述、耦合值、预计改动文件、
   红灯检查（哪个测试/截图/脚本会先失败）、验证档位。
8. **影响面**（M/L）：调用方/页面清单、同类缺陷（进 followUps 还是本次一起修）。
9. **风险与回滚**（L）：方案文档链接、回滚方式、是否需要开关/迁移。
10. **可见界面**（UI）：精确的绝对 `productEntryUrl` 与目标路由。
11. **备选**（XL / 有回退选项时）：可先做的最小切片、"回退引入提交 vs 前向修复"。
12. **重开原因**（新一轮时）：`reopenedBecause` 与上一轮之后发生了什么（假设日志、手测失败、
    新证据）。

**选项**：

- `approved` —— 批准，按方案执行（结局为无改动时：批准该结论，进入报告）。
- `changes-requested` —— 改方案细节、定位或根因不对、或选定 XL 的某个切片（用户说明改
  什么）→ 自动回到 `locate`，修订后重新呈现本门禁。
- `need-info` —— 需要用户先补信息（账号、数据、环境、设计意图）→ `blocked`，
  `waitingFor` 写清要什么。
- `abandon` —— 取消本次修复 → 结局 `abandoned`（`tracker-record` 仍到 Gate ③ 释放认领）。

**必须重过 Gate ① 的变化**：不同的组件/路由/行为、结局变化、升档、熔断触发、新增依赖、
需要改已有测试断言、方案外的文件。

## Gate ② · 手测 + 推送/MR

进入条件：`commit` 已完成；E2E 交接已用当前 diffHash 校验；复核裁决已记录；基线新鲜度
已检查（见 SKILL.md 的 Gate ② 前置检查）。已经推送过（`push-only` 或之前的轮次）时，
卡片额外展示相对上次推送的增量 diff。

**卡片**：

1. **改动**：分支、提交列表、`git diff --stat $BASE...HEAD`、关键 hunk 摘要，每个文件
   对应哪条验收点。
2. **红灯 → 绿灯**：失败检查在 `$BASE` 上的输出首行 → 修复后的通过输出。
3. **验证**：执行过的命令与结果，对照基线列出既有失败（单列，不说成 pass）。
4. **证据**：`conversationMarkdown`（UI）或行为验证说明（非 UI）。
5. **E2E**：决策、受影响路径、台账摘要、回执（`sha256`/`diffHash` 前 12 位）。
6. **复核**：`bugfix-review` 裁决（S 档为自查清单结果）。
7. **手测提示**：逐字复述 `e2e-check` 给出的 `manualTestPrompt`。
8. **将要执行的外向动作**：`git push -u origin HEAD` 到哪个远端分支、Draft MR/PR 的
   标题、目标分支、reviewers（`direct-evidence` 默认不带）。

**选项**：

- `approved` —— 手测通过，推送并建 Draft MR/PR。summary 记用户原话（即手测 evidence）。
- `approved-deferred` —— 手测暂缓，仍推送并建 Draft MR/PR（显式 deferred）。
- `failed` —— 手测失败：summary 写首个失败步骤 + 证据 → 自动回到 `fix`，之后重做验证、
  E2E、复核、提交和本门禁。连续两次失败 `reopen locate` 回 Gate ①。
- `push-only` —— 只推分支供预览环境/CI 测试，暂不建 MR：推送后本门禁保持 `blocked`，
  `waitingFor` = "预览测试结果"，结果回来再问一次。

AskUserQuestion 只放上面四个选项；另外两种答复经"Other"收：用户明确不要推送/建 MR
（"先留在本地"）→ `keep-local`，报告与完成审计如实写"停在本地提交 <sha>"；用户回报具体
环境 blocker → `meta --manual-test blocked --manual-evidence "<blocker>"`，门禁记
`rejected`（summary = blocker），再问用户是 deferred 继续还是等环境。

## Gate ③ · 回写 + 通知（仅 `tracker-record`）

**卡片**：

1. 记录 id + 链接 + 当前状态；`target`（scratch/real）与实际写入的表。
2. 将写入的字段逐项列出：状态值（`fixed` 结局默认 `status.done`；`abandoned` 默认回滚到
   `status.open`；其他无改动结局列出配置的 `tracker.status` 取值与"保持不变"供用户选，
   见 outcomes.md）、备注文本全文（`cannot-reproduce` 含要问提出人的问题）、跟进人、附件
   （仅修改报告且有可见界面时的 before/after）。
3. 通知：后端（connector/lark-cli/cognia/stdout）、接收人（scratch = 操作者本人）、
   卡片标题与链接。

**选项**：

- `approved` —— 回写并通知。
- `writeback-only` —— 只回写，不通知。落盘就记 `writeback-only`（不要记成 `approved`，
  否则续跑会发出通知）；`fix-report` 输出里 `notification.status=not-applicable`，原因写
  用户决定。
- `changes-requested` —— 修改备注或状态值后重新呈现。
- `declined` —— 不回写不通知；`writeback` 记 `not-applicable`，原因写用户决定。
