---
description: 为 UI 修复产出模拟组件 Before/After 截图与对比页；可选本地 dev 活体截图或已确认环境 lane 的真实页面截图。
argument-hint: "[--mode simulated-component|local-dev|real-env] [选项]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **before-after-capture** skill，输入为本次命令附带的参数（无参数时按 skill 自身的缺省输入规则先问）。。

默认 `simulated-component`：确定性本地 fixture，基线修订 + 改后修订同参对比。
`local-dev`：fix worktree 上一个常驻 dev server + 远程后端。
`real-env`：仅显式后续，要求用户提供的已确认环境 lane 与 `productEntryUrl`。
