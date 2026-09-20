---
name: workitem-quick-fix
description: 用于从最新基线分支在隔离 worktree 中快速修复一个外部工作项（工单/issue/story），同时保持已有测试与 E2E 不被破坏。触发语"修复这个工作项""/fix-workitem <id>"。
---

# Workitem Quick Fix

只实现工作项描述的验收缺口。从精确的最新 `origin/<base>`（`FIXER_BASE_BRANCH`）开始，
不动调用方的 checkout，不做与本修复无关的清理或补测工作。

本 skill 编排仓库已有 skills，不替代它们的详细流程。

## 明确需求

1. 优先用 `workitemFetchCommand`（`FIXER_WORKITEM_FETCH_CMD`）或已配置 tracker 适配器的
   读取能力拉取工作项（URL/ID 解析、字段、评论、附件）；都没有时请用户贴出工作项描述。
2. 除非用户另行要求评论、更新字段或流转工作项，工作项系统访问一律只读。
3. 提取可观察的失败现象、预期行为和明确排除项。只有当缺失的选择会实质改变实现时才提问。
4. 如果最新基线上行为已经正确，不做任何产品改动，返回证据与验证结论。

## 建立隔离基线

1. 记录源 checkout 的仓库根目录与 `git status`。绝不清除、stash、暂存或以任何方式改动
   其已有变更。
2. fetch `origin/<base>` 并解析完整 commit SHA。从该 fetch 的 ref 直接创建同级 worktree
   与 `fix/<work-item-id>-<short-slug>` 分支。若路径或分支已存在，先检查；不要删除或
   覆盖。除非已有 worktree 明确属于同一任务且可安全续作，否则加唯一后缀。
3. 立即在新 worktree 内验证：
   - `git rev-parse --show-toplevel` 解析到新 worktree。
   - `git branch --show-current` 是预期的修复分支。
   - 编辑前 `git rev-parse HEAD` 等于 fetch 到的 `origin/<base>` SHA。
4. 之后所有写操作命令都以新 worktree 为显式工作目录。不要把 worktree 创建与工作目录
   含糊的后续写命令串在一起执行。
5. 编辑前读最近的适用 `AGENTS.md`。如果被忽略的生成产物或跨包构建阻碍了最窄验证目标
   运行，仅以达到该目标所需就绪度为限按仓库文档补齐。

## 做最小的修复

1. 在最窄的归属层复现问题或建立等价证据。编辑前追踪实际活跃路径；不要从文件名或过期
   测试推断行为。
2. 只改工作项验收标准所要求的产品代码。不顺带重构邻近代码、升级依赖、格式化无关文件、
   修既有警告或 flaky 测试。
3. 测试代码保界：
   - 运行覆盖受影响路径的既有单测/集成测试与 E2E。
   - 若它们通过且仍覆盖相关契约，不要仅为提升覆盖率或风格去改其 spec、fixture、
     snapshot 或 helper。
   - 若产品修复导致失败，先证明失败由预期行为变化引起，再做最小的对应测试调整。
   - 若失败是既有或无关的，保留证据并汇报；不在本 skill 下修复它。
4. 对用户可见行为、协议或跨包边界，针对实际 diff 与调用路径调用 `e2e-check`。记录其
   结论：`需要 E2E`、`更新已有 E2E` 或 `无需新增 E2E`。
5. 快速修复的授权不包括扩大本已通过的测试/E2E 套件。若 `e2e-check` 证明尽管有保界仍
   必须改覆盖，改测试前先停下询问是否扩范围。获得授权时优先最窄归属层回归。

## 验证与交接

按受影响包与其最近 `AGENTS.md` 做相称的检查：

- 归属层的既有单测或集成测试。
- 路径用户可见或 `e2e-check` 路由到时，跑受影响的既有 E2E。
- 可行时跑改动文件的 lint 与受影响包的 build/typecheck。
- `git diff --check`、`git status`，以及与记录的 `origin/<base>` SHA 的最终 diff/stat。

没跑过的检查不许宣称成功。最终汇报必须写明：工作项、基线 SHA、worktree/分支、改动
文件、命令与结果、任何无关失败、以及测试或 E2E 文件是否有意保持未改。

## 已有能力交接

- 当最终产品 diff 改动了可发布包且仓库策略要求 changeset/changelog 时，用仓库自己的
  发版机制生成。
- 仅在发生真实的 merge、rebase 或 cherry-pick 冲突后按 `branch-sync` §4 处理，冲突解决
  限定在本工作项范围内。
- 仅在用户要求提交时提交。`git add -A` 必须在隔离 worktree 内、确认无无关文件后执行。
- 仅在用户要求创建或更新 MR/PR 时走 `scripts/mr.mjs`（forge 适配器）。目标分支传
  `FIXER_BASE_BRANCH`，并附上原始工作项 URL 以便关联。changeset 检查、push/MR 机制与
  CI 跟进交给仓库自己的流程处理，不在此重复。
- MR 上需要补关联工作项或处理评审评论时，用 tracker/forge 的机制，不在此自实现平台 API。
- 当 MR 流程发现真实 CI 失败时，按仓库 CI 排障入口处理；不要把无关的基础设施或通知告警
  当作产品缺陷。
