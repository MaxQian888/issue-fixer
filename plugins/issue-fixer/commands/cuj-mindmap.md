---
description: 维护仓库的用户路径/CUJ 脑图（tree.json → 校验 → 重建派生产物 → 可选推送白板）。
argument-hint: "<路径/模块/功能改动描述>"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **user-path-mindmap** skill，输入为本次命令附带的参数（无参数时先问要改哪条路径）。

脑图源文件、校验器、生成器归目标仓库所有——`fixer.config.json` 的 `mindmap`
配置定位 `dir` / `lintCommand` / `buildCommand` / `pushCommand`。源文件缺失就停下
报告，绝不从生成产物逆向重建；推送共享白板是破坏性整板覆盖，必须单独取得显式确认。
