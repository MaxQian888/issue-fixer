# 结局（outcome）

每个 run 以且只以一个**结局**结束。结局在 Gate ① 由 agent 提议（Gate ① 前
`runstate.mjs meta --outcome <o> --reason <r>`）、用户批准。Gate ① 批准后证据推翻它时，
先 `runstate.mjs reopen <runDir> locate --reason "<新证据>"`（`locate` 及其后全部回到
`pending`，Gate ① 进入新一轮），再改结局、重过 Gate ①；适用步骤随结局自动重算。

"修好了"只是结局之一。复现不了、最新基线已修、符合设计，都是有证据的正当结局——
用对应结局交付调查报告，比硬改一段代码更有价值。

## 结局表

| 结局 | 判定条件（全部满足） | 必需证据（报告字段） | 改码相关步骤 |
|---|---|---|---|
| `fixed` | 在本仓定位到根因（或经批准的规避点）并交付改动 | 完整修改报告：diff、红灯→绿灯、验证、E2E 交接、手测结果 | 适用 |
| `already-fixed` | 在刚 fetch 的 `origin/<base>` 上按原复现步骤行为正确 | `fixedBy`：修复提交/MR（`git log` 定位），定位不到写明原因；复现记录 | not-applicable |
| `cannot-reproduce` | 按证据尝试了可控的环境维度仍不复现；要问提出人的单个最关键问题已确定 | `needInfo`：那个问题；`investigation`：每次尝试的环境与结果 | not-applicable |
| `not-a-bug` | 当前行为与规格/设计/代码意图一致 | `specRef`：规格、设计稿或代码注释/测试的出处 | not-applicable |
| `duplicate` | 同一指纹已有记录、开放 MR/PR 或进行中的分支 | `duplicateOf`：被重复的对象及其状态 | not-applicable |
| `needs-decision` | 有 ≥2 种合理行为，选哪种是产品/设计决定 | `options`：每个选项及其后果 | not-applicable |
| `external` | 根因在其他仓库、第三方依赖、后端服务、基础设施或环境配置/数据 | `owner` + `handoff`：给归属方的交接说明（可直接转发的问题草稿） | not-applicable |
| `escalated` | 档为 XL；或 L 档且仓库惯例要求先评审、或用户要求先评审 | `proposal`：`tech-proposal` 产出的方案文档 | not-applicable |
| `split` | 一条输入里有多个根因不同的问题 | `children`：≥2 个子 run（issueId + 一句症状） | not-applicable；父 run 出拆分说明，修复报告由子 run 各自出 |
| `abandoned` | 用户在任一门禁取消（Gate ① 答 `abandon`） | 取消原因 | not-applicable；不出报告；`tracker-record` 仍过 Gate ③ 释放认领 |

`external` 的根因不在本仓时，本仓仍可能值得做**规避**：那是结局 `fixed` +
`fixKind=workaround`，需要在 Gate ① 单独批准，并在报告里写明根因归属方与交接说明。
症状层的止血（吞异常、加默认值、放宽校验）是 `fixKind=mitigation`，同样需要单独批准、
写明未消除的根因。只有真正消除了因果链上的缺陷环节才是 `fixKind=root-cause`。

## 各结局的交付

- 无改动结局（`already-fixed` … `split`）：跳过 worktree→CI 整段；`report` 用
  `fix-report` 的 `report-only` 模式交**调查报告**——`report.mjs build` 看到
  `outcome != fixed` 会改用调查报告模板，并校验上表的必需证据。
- **问提出人**：`direct-evidence` 下提出人就是对话里的用户，`needInfo` 等问题直接问。
  `tracker-record` 下到提出人的唯一通道是 Gate ③ 批准后的备注与通知——把问题原文写进
  备注与通知卡片，经 Gate ③ 批准后发出。
- **tracker 状态值**：`tracker-record` 下的无改动结局照样过 Gate ③：卡片展示将写入记录的
  备注（结局 + 结论 + 报告链接）与**用户选定**的状态值。把记录标"无需修复/暂不修复/
  重复"是人的决定：agent 只提议；可选值是配置里 `tracker.status` 的全部取值（必需
  open/claimed/done/fixed；样例配置另给了 notFixing/duplicate/needInfo，表里真有这些选项才
  保留）加"保持不变"，用户也可以直接给出状态字段的
  另一个合法值。用户不选就只写备注、状态保持不变。通知同样经 Gate ③ 批准。
- `split`：父 run 在 Gate ① 呈现拆分方案（每个子问题的指纹、建议顺序、是否共享根因）；
  批准后每个子问题开独立 run（独立 issueId、分支、worktree），父 run 用调查报告模板出一份
  拆分说明（`children`）。共享同一根因的多个症状不拆——一个 run，指纹列全部症状。
  `tracker-record` 下子 run 以 `direct-evidence` 执行并在报告里引用父记录；父 run 的
  Gate ③ 在拆分说明发布后立即进行，不等子 run：备注写"已拆分为 N 个子问题：…"。父记录的
  最终状态在子 run 都结束后由人决定。
- `abandoned`：不出报告。`tracker-record` 下 Gate ③ 默认提议把认领回滚到 `status.open`
  并写取消原因，避免记录永远停在"修复中"、让下一次运行被"已认领"挡住。已经推送了分支或
  建了 Draft MR/PR 时，逐项问用户是否关闭 MR/PR、是否删除远端分支——都是外向动作，不问
  就保留并在总结里列出。保留运行状态与 worktree，按 `worktree-cleaner` 的确认流程处理残留。

## 结局变更的常见路径

- `cannot-reproduce` → 提出人补充了账号/数据/环境 → `reopen locate` → 结局 `fixed` →
  重过 Gate ①。已发布的调查报告、已写的备注在后续步骤里原地更新。
- `fixed` → 改码中发现最新基线已修（rebase 后红灯转绿）→ `reopen locate` → `already-fixed`：
  丢弃本地改动前先问；worktree 按清理流程处理。
- `fixed` → 熔断后发现根因在外部 → `reopen locate` → `external`，或经批准的 `fixed` +
  `workaround`。
- 任意 → 用户在 Gate ① 取消 → `abandon`；在其他门禁取消 → `reopen locate` 后在 Gate ①
  答 `abandon`。
