# 桌面测试

统一入口为 `pnpm --dir desktop test`，由 `run.mjs` 安排构建和执行顺序，不为每个实现模块另增 package script。该入口不启动 Electron，不访问真实远端模型，不触碰用户数据库或剪贴板。

| 位置 | 归属与依赖 |
| --- | --- |
| `*.test.mjs` | 缓存、日志、窗口等模块测试 |
| `main/` | 启动生命周期和 System service；mock Electron／宿主模块，不加载真实 Rust addon |
| `llm/` | 构建后的 Pi worker 与本地 SSE，验证请求映射、事件和取消 |
| `rust-napi/` | 真实 Rust napi 业务联调：Storage、搜索、剪贴板、资源、占用统计、运行时和 LLM 调用链 |
| `fixtures/` | 桌面测试共享辅助代码 |
| `src/renderer/src/**/*.test.tsx`（相对 desktop） | Vitest 组件测试 |
| `e2e/` | 需真实 Electron 的人工显式验收，不纳入自动入口 |

`run.mjs` 构建 Gateway dist 和 desktop worker，再按需要构建正式 Storage／剪贴板 addon。Storage、LLM 的 Rust 测试调用方使用 search 的 `gateway-fixtures`；退出测试窗口后恢复正式 search，其他业务回归只加载正式 addon。迁入的 TS 测试纳入 desktop 的 Node 类型检查。

测试 addon 的构建、失败回收及正式导出检查复用 `scripts/tests/rust-napi-fixtures.mjs`，输出放在 `target/rust-napi-tests/`。即使测试失败，也尝试恢复全部指定 addon；恢复失败会保留并报告错误。不要与 Gateway 测试或相同 addon 的构建并行运行，根 `pnpm test` 已串行执行 workspace 测试。

Gateway 的协议、权限、transport 与通用 worker 测试由 `pnpm gateway:test` 负责；不由该入口运行桌面业务测试。
