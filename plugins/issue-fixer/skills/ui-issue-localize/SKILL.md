---
name: ui-issue-localize
description: >-
  把目标仓库的 UI 问题（问题描述 + 问题截图 + 功能模块）定位到精确的源码
  组件/文件/行号，并给出最小改动方案，采用 静态→动态 混合方法，带人工确认门禁。
  由 issue-orchestrator 调用，或当用户说"定位这个 UI 问题 /
  which component renders X / 从截图找代码"时使用。
---

# ui-issue-localize

把一条 UI 问题记录变成可信的 `file:line` + 最小修复方案。本 skill 绝不动手改——
只定位、只提案；编辑和门禁归 orchestrator。

## 输入契约

接受两种之一：

- `tracker-record`：`recordId`、原文描述、模块/优先级（如有）、原始截图或其确切的
  获取失败原因。
- `direct-evidence`：用户原文描述，外加至少一项：截图、可见文本片段、路由/复现步骤、
  DOM 线索、或能指认可见 UI 界面的报错。

还需要目标仓库 checkout 路径（`FIXER_REPO_DIR`）：orchestrator 建好 fix worktree 后从
该 worktree 读，否则从主 checkout 读（两种情况下这里都只读——编辑归 orchestrator）。
功能模块、路由、视口、主题、语言、账号状态、feature flag 只有在被提供或被观察到时才算
证据；推断值要标注。不要为 direct evidence 编造缺失的 tracker 元数据。

## 方法（静态收窄 → 动态确认）

0. **确认记录指纹。** 用 `recordId + 问题描述 + 模块 + 原始截图` 一起确认。表格行号/
   工作项编号只是选记录，从不描述目标。截图私有/拿不到就明说。文字与图片矛盾就停下问。
1. **模块 → 区域映射。** 把报告的功能模块映射到代码区域。收窄依据按仓库现状选：
   路由表（router config / 文件路由目录）、页面地图/CUJ 树这类路径文档、组件目录约定、
   `AGENTS.md`/README 的架构说明。路径文档先用 `git ls-files` 确认是当前分支的跟踪文件。
   没有现成地图时，路由 → 页面组件 → 子组件 的调用链就是地图。
2. **grep 症状。** 在收窄后的区域搜截图中的可见文本、元素角色、涉事样式属性（如
   height/padding/`aspect-`、颜色、z-index、overflow）。优先用截图里的字面字符串。
   选定文件前检查调用方和样式归属：包含可见文本的组件不一定是拥有布局的组件。顺查
   import 的 CSS、工具类、包裹组件、响应式变体。把精确的搜索词与候选文件留在结果里，
   让结论可复现。
3. **动态确认——仅当静态锚点不够时。** 通过 `before-after-capture` 的 `local-dev` 通道
   起一个常驻本地 dev server（`capture.devServerCommand` 配置，本地前端 + 远程后端，
   一次带健康检查的启动，整轮复用）。fix worktree 已存在就 serve 它，否则 serve 主
   checkout——dev server 只读源码，不违反"主仓不动"规则。然后在
   `http://localhost:<port><route>` 上用 Playwright MCP / DevTools 在活 DOM 里选中元素，
   映射回源组件。定位不许部署环境，也不许起完整本地后端栈。
   若认证或后端状态缺失挡住活体检查，回退为读组件 + 其唯一调用点（props 会告诉你渲染
   上下文）。
   断言精确组件前要求两个独立锚点，如 可见文本 + DOM 归属、截图几何 + 匹配样式、
   路由归属 + 唯一调用点。
4. **提最小改动。** 满足描述的最小外科手术式编辑。标出必须一起动的**耦合值**（偏移量、
   按旧尺寸调的魔法常数）——这里的主要失败模式就是破坏布局的天真单行改动。

## 置信度规则

置信度来自独立证据，不来自直觉：

- `high`：路由归属 + 活 DOM/源码匹配，或三个静态锚点（唯一文本/角色、样式归属、调用方
  上下文）。
- `medium`：两个独立静态锚点指向同一主候选，但无法活体复现。
- `low`：多个可疑归属、只有模块级猜测、或证据区分不了状态与样式。

`high`/`medium` 进 gate ①；`medium` 要披露还没验证什么。`low` 返回候选 + 一个聚焦
问题；不要把精确位置说成事实。

## 输出（返回给 orchestrator）

返回结构化结果：

```yaml
classification: ui
locateFile: packages/...
line: 1
owner: ComponentOrStyleRule
confidence: high | medium | low
anchors: [{ kind: text | route | dom | style | caller | geometry, evidence: string }]
alternates: [{ file: string, line: number, reason: string }]
route: string
state: { viewport: string, theme: string, auth: string, featureFlags: [] }
planSummary: string
coupledValues: [{ file: string, line: number, reason: string }]
unverified: [string]
question: string | null
```

用仓库相对路径与当前 1 起始行号。alternates 至多两个。引用所解释的确切描述或视觉事实；
不要只说"与截图一致"。
