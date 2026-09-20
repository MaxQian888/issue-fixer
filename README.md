# issue-fixer

一个通用的、适配器驱动的 issue 修复流水线（Claude Code / Codex 插件市场）。
把一条 issue——tracker 记录或直接证据——变成在隔离 worktree 中完成、带验证的
修复与交付，全程三个人工门禁。

```
读记录/取证 → 定位代码 → 🚦 方案 → worktree 修复 → 验证 → before/after 证据
→ E2E 覆盖 → 🚦 用户测试 + Draft MR/PR → CI → 报告 → 🚦 tracker 回写 + 通知
```

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
   - **forge**：`git`（只推分支、如实报 pending）、`github`（`gh pr create` +
     head 去重）、`custom`（`mrCommand`/`mrListCommand` 模板）。
   - **notify**：`stdout` 或 `lark`（connector / lark-cli 回退）。
   - **report**：`markdown`、`lark-docx`、`custom`。
   - **deploy**：可选命令模板；不配则部署步骤如实 `not-applicable`。
3. `target: "scratch"`（默认）下一切 tracker 写操作打到配置的 scratch 表；没有
   scratch 表时写操作被拒绝。`real` 才动生产记录。

## 入口

- `/fix-issue <recordId 或问题描述>` — 端到端流水线。
- `/check-e2e [ref]` — 独立 E2E 覆盖检查（不依赖主插件）。
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
