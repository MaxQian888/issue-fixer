# issue-fixer

一个通用的、适配器驱动的 issue 修复流水线（Claude Code / Codex 插件市场）。
把一条 issue——tracker 记录或直接证据——变成在隔离 worktree 中完成、带验证的
修复与交付，全程三个人工门禁。

```
取证 → 分诊定档 → 复现 → 定位根因 → 🚦 方案 → worktree 红灯 → 修复 → 验证
→ before/after 证据 → E2E 覆盖 → 复核 → 提交 → 🚦 用户测试 + 推送/Draft MR/PR
→ CI → 报告 → 🚦 tracker 回写 + 通知
```

规模档 S/M/L/XL 只调每步深度（复现、根因、红灯、复核、熔断预算），不删步骤；XL 出方案
不修。无需改码的结论（最新基线已修、无法复现、符合设计、重复、外部根因、待决策）以带证据的
调查报告收尾。运行状态、指纹与进度块经 `plugins/issue-fixer/scripts/lib/runstate.mjs` CLI。

## 仓库内容

| 路径 | 内容 |
|---|---|
| `plugins/issue-fixer` | 主编排插件：orchestrator、定位、截图、报告、worktree 生命周期、治理与分流 skills + hooks |
| `plugins/e2e-check` | 独立 E2E 覆盖插件：diff 快照 → 用户路径 → 断言级审计 → 缺口补齐，版本化结果落盘 |
| `fixer.config.example.json` | 全部可配置项的注释样例 |
| `design.md` | 适配器架构与流水线契约的设计说明 |
| `AGENTS.md` | 运行该流水线的强制工作流契约 |

## 与目标项目对接

1. 在目标仓库根放 `fixer.config.json`（或 `.fixer/config.json`，或设 `FIXER_CONFIG`），
   从 `fixer.config.example.json` 拷起。最少要配 `repoDir` 与 `baseBranch`。
2. 选适配器：
   - **tracker**：`none`（只做直接证据）或 `lark-base`（内置，含 scratch 护栏）。
   - **forge**：`github`（推荐——`gh pr create` + head 去重并更新已有 PR、
     `gh pr checks` 做 CI 跟进，`forge.repo` 留空时自动从 origin remote 解析
     owner/name，只需 `gh auth login`）、`git`（只推分支、如实报 pending）、
     `custom`（`mrCommand`/`mrListCommand` 模板）。
   - **notify**：`stdout`、`lark`（connector / lark-cli DM·群卡片回退）或 `cognia`
     （复用宿主 bot 设施：`cognia-agent api call connector_send` 入绑定会话）。
   - **host**：`none`（默认，纯本地）或 `cognia`——宿主命令平面
     （`lib/cognia.mjs`），被 notify/progress/bot kit 共享；CLI 依次取
     `host.cogniaBin` → PATH → `<repoDir>/cli/dist/cognia-agent.mjs`，
     session 依次取 `host.sessionId` → `COGNIA_SESSION_ID`。
   - **report**：`markdown`、`lark-docx`、`custom`。
   - **deploy**：可选命令模板；不配则部署步骤如实 `not-applicable`。
3. `target: "scratch"`（默认）下一切 tracker 写操作打到配置的 scratch 表；没有
   scratch 表时写操作被拒绝。`real` 才动生产记录。

### 本地 lark-cli 组合场景

最常见的本地组合是三个 lark 适配器一起用，形成完整的飞书闭环：

```jsonc
{
  "tracker": { "type": "lark-base", "baseToken": "…", "tableId": "…",
               "scratchBaseToken": "…", "scratchTableId": "…" },
  "notify":  { "type": "lark" },          // openId 可留空
  "report":  { "type": "lark-docx" }
}
```

前置只有一条：`lark-cli` 在 PATH 且 `lark-cli auth login` 完成。其余自动：

- SessionStart 钩子会探测 `lark-cli whoami`，把就绪状态注入上下文
  （未登录 → 提示先 login；未配置任何 lark 适配器时完全跳过探测）。
- `tracker.mjs preflight` 在第一条记录读写前一次检查 二进制 + 登录态 + 表配置，
  返回操作者 open_id 与分类好的 blocker（missing_bin / unauthenticated / config）。
- `tracker.reporterOf(record)` 把提出人 user 单元格归一成 `{openId, name}`，
  不需要手抠单元格形状。
- `notifyOpenId` 缺省时自动回退到 whoami 的操作者 open_id——scratch 模式下
  卡片 DM 给操作者本人，零配置可用。`notify.openId` 也接受姓名/邮箱（经
  `contact +search-user` 解析）；配置 `notify.chatId` 则改发群卡片。
- 没有 scratch 表时一条命令建好：`node plugins/issue-fixer/scripts/lib/tracker.mjs
  init-scratch` —— 用 `base +base-create` 按 `tracker.fields` 语义建表，返回可直接
  粘贴的 `configSnippet`。
- 证据里的飞书链接先取回再引用：`scripts/evidence.mjs collect` 扫描输入/记录字段，
  把 docx/wiki 拉成 markdown、minutes 拉摘要+逐字稿、`om_` 消息连附件一起下载，
  产物与清单落在 `<runDir>/evidence/`。
- 所有 lark-cli 调用经 `lib/lark.mjs`：统一 `--as` 身份、envelope 解析、
  scope/permission/rate_limit 错误分类与退避重试。

### Cognia 宿主组合场景

目标仓库本身是 Cognia（或运行时有 Cognia 宿主）时，把 `host.type` 设为
`cognia` 即可复用宿主设施，而不是另起一套：

```jsonc
{
  "host":   { "type": "cognia" },   // cogniaBin/sessionId 都可留空自动解析
  "notify": { "type": "cognia" },   // 修复报告进绑定会话
  "progressPush": true              // 可选：每个步骤流转也推到会话（bot/无人值守用）
}
```

- **出站**：`connector_send` markdown 片段入绑定会话——宿主自己的 bot 走的
  受治理投递面（delivery-gateway + 主体规则），不需要 lark-cli。
- **入站**：`integrations/cognia/bot.issue-fixer.json` 是一份
  `PluginBotDef` 形态的定义——`interaction` 触发让"在绑定会话里报问题"
  直接起一个修复 run，`manual` 触发给手动入口，`schedule` 触发做定时
  扫描。门禁映射到宿主决策面（`requireApprovalForWrites` + 共享
  interrupt 表），不需要自架 HIL。
- **PR 应答**：`correlationKey` 事件触发可以让等待中的 run 被
  `check_run.completed` 唤醒——比轮询 `mr.mjs checks` 更省。
- 细节与安装草案见 `integrations/cognia/README.md`。一切调用经
  `lib/cognia.mjs`：宿主没配置时返回分类 blocker，绝不伪装成功。

### Cognia 插件格式

每个插件目录同时是一份合法的 Cognia 插件：根部的 `plugin.json`
（`type: frontend`，`capabilities: skills + command-hooks`）+ `dist/index.js`
（导出的 manifest 与打包 manifest 严格同构，宿主 parity 检查直接过）。skills/
以 `local-bundle` 整体贡献，commands/ 转成 inline prompt skills，
hooks/hooks.json 映射为 `commandHooks`。

安装（宿主侧）：

```bash
# GitHub 源（指定插件子目录）
cognia-agent api call plugin_install_from_github --repo <owner>/issue-fixer \
  --subdir plugins/issue-fixer
# 本地开发：把插件目录放进 Cognia 的 dev-plugins 目录后
# cognia-agent run --dev-plugins 即可加载
```

产物由规范转换器生成、随仓库提交（GitHub 安装是 build-free 的）。
维护者改了 skills/commands/hooks 后重新生成：

```bash
FIXER_COGNIA_CONVERT=/path/to/plugin-convert.cjs pnpm build:cognia
pnpm check:cognia   # 校验已提交产物没有漂移
```

转换器来自托管 `cognia` CLI 内嵌的同一模块（`plugin import`）；本机有
`cognia` 时自动走它。注意：转换器拒绝 `$ARGUMENTS`/`$1` 替换——命令参数一律
写成自然语言（"本次命令附带的参数"），两个生态都能跑。

## 入口

- `/fix-issue <recordId 或问题描述>` — 端到端流水线。
- `/check-e2e [ref]` — 独立 E2E 覆盖检查（不依赖主插件）。
- `/tech-proposal` — 技术方案/设计文档（SCQA + 金字塔 + 评审门禁，发布走 report 适配器）。
- `/tracking-doc` — 埋点盘点：扫描事件上报 → 设计文档 + CSV（`analytics.patterns` 可配）。
- `/cuj-mindmap` — 用户路径/CUJ 脑图维护（仓库自有 tree.json + lint/build/push 命令）。
- `/ci-report` — CI 日报/周报（GitHub Actions 优先，失败聚类 + 覆盖警告，可发布+群推送）。
- `/review-fix` — 独立复核：当前 diff 是否真修复所报告问题（因果链裁决，不带先前诊断）。
- `/verify-claim`、`/prototype`、`/localize-ui-issue`、`/before-after`、`/report`、
  `/worktree-start`、`/branch-sync`、`/worktree-clean` — 单点工具，不走门禁。

## 两条输入模式

- **tracker-record**：读记录 → 认领 → 下载证据 → … → 回写 + 通知提出人。
- **direct-evidence**：用户直接给的描述/截图/报错。不查 tracker、不回写、
  不通知；报告走 `report-only`。SessionStart 钩子注入的
  `[issue-fixer:direct-evidence]` 标记是权威的。

## 测试

```bash
pnpm test                # node:test 契约测试
pnpm validate:plugins    # marketplace/manifest/skill/hook 结构校验
```
