---
description: 把一个改动/需求产出为拉评审就绪的技术方案文档：定深度裁章节、逐节起草、自检门禁、经 report 适配器发布。
argument-hint: "<要评审的改动或需求描述>"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task, AskUserQuestion
---

驱动 **tech-proposal** skill，输入为本次命令附带的参数（无参数时先问要给什么改动写方案）。

先取材定位（需求来源、分层、抄近邻样板），定深度裁章节后先把大纲+执行摘要草稿报用户确认，
再逐节起草；跑完评审反模式自检门禁才算完成。产出先落目标仓库设计文档目录的 md 草稿，
再按 `report` 适配器发布（markdown 默认 / lark-docx 需先问落地节点）。
