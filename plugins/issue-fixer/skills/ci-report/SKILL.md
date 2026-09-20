---
name: ci-report
description: >-
  生成 CI 日报/周报：枚举窗口内的流水线执行、失败 job/step 证据采集、错误签名聚类、
  失败率与耗时统计、候选协作者（PR 作者 / CODEOWNERS / 触发人）、覆盖范围警告，
  产出 Markdown 报告并可选经 report adapter 发布 + 推送群摘要。默认走 GitHub
  CLI（gh run list/view/api），支持 --repo/--ref/--since/--until/--tz/--dry-run。
  其他 forge 通过产出同一规范化 run 形态接入，不在核心流程里硬编码平台 API。
---

# CI 日报 / 周报

从 CI 执行事实生成周期报告。入口：

```bash
node <plugin-root>/scripts/ci-report.mjs --kind daily [--period yesterday] [--tz Asia/Shanghai]
node <plugin-root>/scripts/ci-report.mjs --kind weekly --repo owner/name --ref dev --publish --chat-id oc_xxx
```

## 参数与窗口

| 参数 | 语义 |
|---|---|
| `--kind daily\|weekly` | 必填；daily 默认 yesterday，weekly 默认 last-week（周一到周日） |
| `--period` | `today`/`yesterday`/`this-week`/`last-week`/`YYYY-MM-DD`/`YYYY-MM-DD..YYYY-MM-DD` |
| `--since --until` | 显式日期闭区间（必须成对给出，YYYY-MM-DD） |
| `--tz` | IANA 时区；默认 `report.timezone` 配置，再默认 `UTC` |
| `--repo` | `owner/name`；默认 `forge.repo` 或从 `origin` remote 推断 |
| `--ref` | 限定分支，可重复；不给则枚举全部 ref |
| `--owners` | CODEOWNERS 路径；默认自动探测 `.github/CODEOWNERS` 等 |
| `--out` | 产物目录，默认 `<repoDir>/ci-reports/` |
| `--publish` | 经 `report.type` 适配器发布文档（markdown/lark-docx/custom） |
| `--chat-id` | 推送群摘要卡片（lark-cli） |
| `--dry-run` | 只采集+构建，写结果到 stdout，不落盘不发布 |
| `--limit` / `--max-failed` | 枚举上限（默认 500）/ 失败日志采集上限（默认 50） |

## 数据纪律

- **原始日志只留内存**：失败 step 日志经 `gh run view --log-failed` 拉到内存，提取
  脱敏错误签名 + 仓库内栈帧后立即丢弃；持久化的只有签名、分类、计数——绝不写入
  token、cookie、authorization header、环境变量值。
- **失败原因不编造**：日志拿不到时 `evidenceLevel=metadata` 并进 `evidenceGaps`；
  分类器不确定时 `category=other`，报告写「证据不足，不推测」。
- **候选协作者三种角色分开**：`change-follow-up`（PR 作者）、`code-routing`
  （CODEOWNERS 最具体匹配）、`operator`（触发人）。报告声明这不构成责任认定。
- **覆盖警告必须保留**：`--limit` 截断、`--max-failed` 超限、detail/jobs 接口失败、
  PR 关联失败都进 `coverageWarnings`，报告「覆盖范围与限制」节逐条列出——不得声称
  全量完整。
- **窗口边界**：`[since 00:00, until+1d 00:00)` 在所声明时区内；跨 DST 日期用窗口
  起始日的 offset，边缘情况记入警告而非静默吸收。

## 交付物

- `<out>/ci-<kind>-<since>[-<until>].md`：报告正文（核心指标 / 失败簇 / 覆盖范围与限制）
- `<out>/ci-<kind>-<since>[-<until>].json`：结构化报告 + digest（sha256，剔除
  snapshotAt/publication 后可复算）
- `--publish` 时：`publishReport` 返回的 `publication.url`
- `--chat-id` 时：群摘要卡片（标题、执行/失败/成功率/P95、Top3 失败簇、覆盖缺口计数）

## 非 GitHub 扩展

collector 只负责产出规范化 run：

```jsonc
{
  "runId": "…", "pipeline": "<workflow>", "status": "succeeded|failed|running|canceled|unknown",
  "durationMs": 0, "branch": "…", "url": "…", "triggerer": "<login|null>",
  "mr": { "id": 123, "author": "<login>" } | null,
  "failure": { "job": "…", "step": "…", "category": "…", "errorSignature": "…",
               "frames": ["src/a.ts:10"], "codeOwners": ["@x"], "evidenceLevel": "signature|metadata" } | null
}
```

其他 forge 写自己的 collector（`collectGithubRuns` 的 `ghImpl` 注入点就是为
测试与替换准备的），`buildCiReport`/`renderReportMarkdown` 平台无关。
