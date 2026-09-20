---
description: 独立分析当前仓库 diff、给出手动测试提示、关闭 E2E 缺口并持久化可恢复结果。
argument-hint: [comparison-ref] [--output /absolute/e2e-result.json]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

为当前仓库 checkout 驱动 **e2e-check** skill。

本命令始终使用 `standalone` 模式，不要求 `issue-fixer`。

`$1` 存在时作为对比 ref。否则解析仓库文档记载的目标分支（`FIXER_BASE_BRANCH` 或默认
main），用其与 `HEAD` 的 merge-base；有多个合理目标时先问再审计。用 `result.mjs snapshot`
让已提交、已暂存、未暂存及相关未跟踪改动都计入 diff 身份。`--output` 缺席时，持久化到
仓库外 `<repo-parent>/.e2e-check-artifacts/<runId>/e2e-result.json`。

推导具体用户路径，非阻塞地给出手动测试提示，然后审计断言级 E2E 覆盖，并用归属的既有仓库
E2E harness 补齐并跑通每个缺失或 partial 的回归。
不要停在一张建议测试清单上。返回结构化覆盖结果，并向用户展示手动测试提示。用户可以立即
回报结果或显式 deferred；他们报告失败时，用该证据恢复同一检查。始终返回校验后的结果路径、
SHA-256 回执、最终 diff 哈希、决策、命令证据与 blockers。
