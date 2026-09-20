# 验证档位命令表

worktree-flow 第 5 步各档位的具体命令。只取与本次改动面匹配的行。
命令优先取 `fixer.config.json` 的 `verify.*` / `FIXER_*` 配置；未配置时按下表从仓库
工具链推断（package.json scripts、Makefile、turbo/nx 配置、CI yaml 是事实源）。

## 档位表

| 改动面 | 命令 |
|---|---|
| 纯样式/文案 | 仓库 lint（`verify.lint` 或 `pnpm lint`/`npm run lint`/`make lint`）+ 浏览器目视/截图 |
| 逻辑/缺陷修复 | 最窄 owning layer 测试（`verify.test` 或该包的 test runner）+ 受影响包 build/typecheck |
| 用户可见行为/协议 | `e2e-check` 判定 → 需要则补/跑仓库 E2E harness |
| 性能 | 前后实测：接口计时 / 渲染次数 / bundle 体积 / 列表帧率，给数据表 |
| 提交前 | 仓库的 commit message 校验钩子；发版包按仓库约定生成 changeset/changelog |

## 单测命令的坑（通用）

- watch 是多数 test runner 的默认：vitest 一律显式 `vitest run`（裸 `vitest`/`pnpm test`
  常是 watch 会挂住）；jest 用 `--watchAll=false`；确认 `test` script 是单次还是 watch
  再跑。
- monorepo 根目录裸跑 `test` 可能跨包收集且别名/环境全错——按包名过滤或带文件参数跑。
- 不同包可能用不同 runner（vitest / jest / node:test / cargo test / go test）——以该包
  `package.json`/`Cargo.toml`/仓库文档为准，别假设全仓统一。
- 缺 lint/typecheck 二进制是 preflight 失败，不是豁免验证的许可：先按仓库锁定安装恢复
  devDependencies，或跑仓库支持的 CI 等价命令。

## 性能实测建议

- 接口类：真实链路打 `performance.now()` 或 DevTools network 采样，报 P50/P95 与样本量。
- 列表/渲染类：帧率或渲染计数对比；标注测试数据规模。
- "应该会快"不算结论；给不出测量方法时先和用户对齐怎么测。
