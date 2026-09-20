---
name: before-after-capture
description: >-
  为 UI 修复产出确定性的模拟组件 Before/After 截图；当 fixture 无法呈现状态时，
  在一个常驻本地 dev server（本地前端 + 远程后端）上做快速的活体截图；完成后用户给出
  环境 lane 时可选做一次真实环境页面截图。由 issue-orchestrator 调用，或当用户说
  "截个 before/after / 看下视觉 diff / 对比修复前后"时使用。默认走模拟通道，
  认证与部署永远不阻塞主修复流程。
---

# before-after-capture

默认产物是 `before.png`、`after.png`（同组件/同状态/同视口）和 `compare.html`。
可选的后续产物是来自已确认环境 lane 的一张 `real.png`。

## 模式选择——动手前先定

默认模式：**`simulated-component`**。选能呈现所报状态的最便宜通道。

- **`simulated-component`**：在确定性本地 fixture 中渲染定位到的组件，分别取基线修订与
  改后修订。每张图和每处摘要都要明确标注为模拟。不做认证探测、不检查浏览器会话、
  不发现/部署环境、不起完整产品栈。
- **`local-dev`**：真实路由由 fix worktree 上一个常驻 dev server 提供，连远程后端——
  无部署、无产品域 SSO 墙。当组件需要深层 provider/真实数据、搭 fixture 比起一个
  server 还慢时，或 Gate ① 要求活体确认时，或想要活体证据又不想等部署时用它。截图标注
  `live local dev + remote backend`，绝不标 `real-env`。
- **`real-env`（仅显式后续）**：要求用户提供环境 lane 或已确认的部署输出。仅在主流程
  完成后运行。

## 输入契约

`simulated-component` 要求 `issueId`、目标仓库 checkout、目标组件/selector、视口、
基线修订、after 修订、产物目录、预期视觉属性或行为。组件或基线修订未知时，回到定位
环节，不要截一张通用页面充数。

`local-dev` 要求 fix worktree、精确路由、目标 selector、视口、可达的远程后端
（`capture.devServerCommand` 配置启动命令）。server 每轮只起一次，复用于验证、两次
截图和任何修复迭代。

`real-env` 要求已完成的主结果加上 `productEntryUrl`、精确路由、目标 selector、视口、
已确认的环境 lane 和 `capture.envHeaders` 头模板（如
`{"x-tt-env":"{env}","x-use-ppe":"1"}`）。`productEntryUrl` 是定位/Gate ① 阶段定下的
产品 web 入口绝对地址；不要从任务 URL、环境名、service id 或猜测的域名推导。任一
real-env 输入缺失时，只问那一个值并停止后续。

模拟截图保持视口、设备缩放、语言、主题、预置数据、feature flag、滚动位置、交互状态
完全一致。控制不了的维度要记录。时间戳这类易变内容只有在与修复无关时才隐藏/遮盖，
且两次截图用同一遮盖。

## 模拟组件截图

用能渲染目标组件的最轻确定性界面：

- 优先现有 Storybook/story/测试 fixture。
- 否则在仓库外建一个临时最小页面，import 真实组件并给有代表性的 props。fixture 不提交。
- 基线与 after 用同一份 fixture props。只复现与问题相关的状态。
- 每张 PNG 必须在组件裁剪区之外带可见的 `SIMULATED` 水印或边框标注，使图片脱离
  `compare.html` 或作为附件上传后仍不含糊。

不要仅为产出默认证据去起完整前端、远程后端或本地后端栈。组件无法孤立渲染时，报告
这个具体限制；不要静默升级到 `real-env`。

## 本地 dev 截图——一个常驻 server

在 fix worktree 上起一次 server，整轮保活：验证、before/after 截图、每次修复迭代都复用
它。热更新会反映新编辑，绝不按迭代重启。

1. 用 `capture.devServerCommand` 配置启动（仓库 wrapper 脚本或
   `pnpm --filter <web> dev` 这类）；要求 detached 启动 + 对打印出的端口做健康检查。
   纯前端检查不要起本地后端——那是另一条通道。
2. 对 `http://localhost:<port><route>` 截图。优先仓库的预览/截图工具（Playwright MCP 等）；
   不可用时用确定性脚本路径
   `node <plugin-root>/scripts/capture.mjs shot <url> <out.png> --auth --wait-selector <selector>
   --width <w> --height <h>`。localhost origin 不在产品域 SSO 墙后；`--auth` 按
   `capture.authTokenVars` / `capture.authTokenCommand` 解析令牌并按 `capture.authHeader`
   + `capture.authInitScript` 注入。当所报状态需要用户真实会话数据时，改为驱动已挂接的
   认证主浏览器。
3. 趁 worktree 还在记录的基线 SHA 时截 `before`——在修复编辑落地之前；同一个运行中的
   server 随后通过热更新 serve `after`。若运行在编辑之后才恢复，回退到用一个干净的基线
   worktree 截 `before`。
4. 活体截图仅当拿到预期最终 URL、`authWall:false`、`expectedSelectorFound:true` 才接受。
   若路由需要远程后端无法为该用户产生的后端状态，报告该限制——不要静默升级到
   `real-env`。

## 真实环境后续——一次导航，不做探索

需要认证的产品路由依赖用户已有的会话，可能还要浏览器扩展。只复用已挂接到任务的认证
主浏览器。不要导出浏览器状态、解析机器凭据、或另起浏览器 profile。

1. 导航前在 `productEntryUrl` 上配置 `capture.envHeaders` 模板展开后的环境头
   （如 `x-tt-env: <已确认 lane>` + `x-use-ppe: 1`）。lane 值是环境标签，绝不是 hostname。
2. 对精确的 `productEntryUrl + route` 做一次导航。这同一导航即是认证探测、路由验证和
   截图尝试。
3. 要求预期最终 URL、`authWall:false`、定位到的 selector。全部通过则在同一 tab 截
   `real.png`，作为真实环境页面截图返回。
4. 遇到登录/SSO 重定向、路由不匹配、selector 缺失、浏览器不可用，返回具体 blocker。
   不要试替代域名、header 或 lane 名，不要试替代凭据或 profile。

绝不读取或打印 cookie、token、profile 或浏览器状态内容。若登录是 blocker，请用户在主
浏览器完成 SSO 并在目标页面可见后回复；下一次调用可再做一次新尝试。

## 模拟基线纪律

1. **Before**：趁 fix worktree 还在记录的基线 SHA 时截 `before.png`——在编辑落地之前；
   这让常规路径不再需要额外的基线 worktree。干净的基线 worktree（改动前 commit）只是
   运行在编辑之后重启时的恢复兜底。不要为了拿基线去 stash、reset 或覆盖无关用户改动；
   若错过编辑前截图且没有基线 worktree，向用户索要已知的基线产物。
2. 应用修复（orchestrator 第 4 步）。
3. **After**：同一 fixture/视口截图 → `after.png`。
4. `node <root>/scripts/capture.mjs compare before.png after.png compare.html "<label>"`。

交互依赖的改动，先定义状态再截图，两个修订都要套。例如默认隐藏、悬浮显示的滚动条需要
四个产物：`before-default`、`before-hover`、`after-default`、`after-hover`。跨修订比较
对应状态；光有两个 after 状态只证明新规则存在，不证明回归被修复。focus、展开、加载、
错误、移动端、暗色状态只有在属于问题本身或可能被改动 selector 影响时才截。

## 会话正文呈现

除文件外，返回一个可直接渲染的 `conversationMarkdown` 值。构造成 Markdown 图片表格，
图片目标是产物的**绝对本地路径**。会话渲染器可以直接显示这些本地 PNG 路径；不要用
`图` 字、文件名、`compare.html` 链接或其他占位符替代。

单状态时用 Before、After 两列。`simulated-component` 模式下列名标 `Before · 模拟修复前`
和 `After · 模拟修复后`。交互状态用矩阵：状态名做行、Before/After 做列，default/hover
产出 2×2 图片网格：

```markdown
| 状态 | Before · 修复前 | After · 修复后 |
| --- | --- | --- |
| 默认态 | ![before default](/absolute/run/before-default.png) | ![after default](/absolute/run/after-default.png) |
| 悬浮态 | ![before hover](/absolute/run/before-hover.png) | ![after hover](/absolute/run/after-hover.png) |
```

绝对路径含空格时给图片目标加 `<...>`。表格只放校验过的截图。通知卡片、报告文档或
`compare.html` 可以补充这个呈现，但不能替代会话正文里的真实 PNG。

`real-env` 后续成功时，单独返回 `![真实环境页面](/absolute/run/real.png)` 作为会话图片。
不要把它改标成 Before/After 对比；模拟对比仍是主证据。

原始问题截图（若可下载）作为用户上报参考附进报告，与生成的基线证据分开。

## 输出

`simulated-component` 返回 `before.png`、`after.png`、`compare.html`、一行
`beforeAfterNote` 和 `conversationMarkdown`。`local-dev` 返回相同字段外加 live server
坐标，标注为活体 local-dev 证据。`real-env` 返回一张 `real.png` 及其验证过的
URL/auth/selector 证据；它绝不替代模拟产物。

### `simulated-component` 输出

```yaml
mode: simulated-component
surface: isolated-component
browserMode: fixture-browser
env: not-applicable
productEntryUrl: not-applicable
route: string
selector: string
viewport: { width: number, height: number }
baselineRevision: string
afterRevision: string
before: { path: string, finalUrl: string, authWall: boolean, selectorFound: boolean }
after: { path: string, finalUrl: string, authWall: boolean, selectorFound: boolean }
states: [{ name: string, beforePath: string, afterPath: string, action: string }]
compare: string
conversationMarkdown: string
measurement: { property: string, before: string, after: string }
limitations: [string]
```

### `real-env` 输出

```yaml
mode: real-env
surface: full-page
browserMode: main-reused
env: string
productEntryUrl: string
route: string
selector: string
viewport: { width: number, height: number }
real: { path: string, finalUrl: string, authWall: boolean, selectorFound: boolean }
conversationMarkdown: string
limitations: [string]
```

### `local-dev` 输出

字段同 `simulated-component`，但 `mode: local-dev`、`surface: live-route`，并增加
`server: { port: number, backend: remote }`；图片标 `live local dev + remote backend`
而不是 `SIMULATED`。

`simulated-component` 仅当两文件存在且非空、目标组件都在、fixture props 一致、每张 PNG
有可见模拟标注时才接受该对比。`local-dev` 仅当两次截图都命中预期路由、找到目标
selector、且 `authWall:false` 才接受。`real-env` 仅当单次导航到达预期 URL、找到目标
selector、且不是认证墙时才接受 `real.png`。光有一张某生成的 PNG 不是有效截图的证据。
