---
description: 扫描代码盘点埋点/事件上报，生成埋点设计 Markdown（可选 CSV 清单与 E2E 覆盖对齐）。
argument-hint: "<扫描路径或范围描述> [--candidates]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **tracking-doc** skill，输入为本次命令附带的参数（无参数时先问扫描范围）。

事件调用约定由目标仓库 `fixer.config.json` 的 `analytics.patterns`（正则列表）与
`analytics.exclude` 配置；默认模式覆盖常见 track/capture/analytics 调用。扫描证据用
`scripts/scan-tracking.mjs` 产出——它只定位，业务语义由你解析。物理 event 与逻辑子事件
分离、声明不等于上报、候选不等于缺口，这三条不可妥协。
