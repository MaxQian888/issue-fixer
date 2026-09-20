---
description: 构建一次性原型回答一个设计/状态模型/UI 形态问题；产物不进交付 diff。
argument-hint: <要回答的问题>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **prototype** skill，输入为 `$ARGUMENTS`。

先识别要回答的问题类型：逻辑/状态模型 → 终端交互原型（LOGIC.md）；UI 形态 → 同路由
多变体（UI.md）。一次性代码放被验证对象旁边、命名标明原型、一条命令跑起来、状态不
持久化。答完问题即删或把结论折进真实代码。
