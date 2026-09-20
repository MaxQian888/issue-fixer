---
description: 先取证再判定：用代码证据检验 review 评论、bug 转述或性能声明是否成立，证实才改。
argument-hint: <论断或评论>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

驱动 **claim-verify-first** skill，输入为 `$ARGUMENTS`。

把论断拆成可证伪命题，沿调用链取证（触发条件 + 代码路径 + 预期行为），逐条判定：
证实 → 最小修复；证否/已修 → 给反证不动代码；证据不足 → 说清缺什么。性能论断要前后
实测对比。
