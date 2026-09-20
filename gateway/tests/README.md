# Gateway 共享验收

`wire-cases.json` 由 Rust `tests/core.rs` 和 TS `test/core.test.ts` 共同执行，覆盖空 PB message、uint64 上限和损坏 wire。复杂 optional／oneof／2 MiB bytes 往返使用 `testing.Fixture` 契约，在 TS `test/transport.test.ts` 与 Rust `examples/fixture_transport.rs` 间执行；测试 service 不向产品注册。

Rust `tests/core.rs` 保留旧 invoke／event 测试覆盖的注册、typed 参数、远端回退、并发、filter、Ordered burst、backend 订阅保留／解绑、旧连接投递和 owner 清理语义；以 PB 和注入 transport／sink 替换旧 JSON／Tauri／socket 装配。新增批内重名、跨 routes／events 原子性、超时后真实任务占用、连接替换与迟到结果、白名单及协议兼容测试。两端有编译期错误入参／返回值反例。


`pnpm gateway:test-native` 由 `native.mjs` 构建两个带测试 feature 的真实 addon，并运行 `ts/test/native/bridge.test.ts`，最后恢复正常构建产物。覆盖本地优先、双向调用、重入、PB 大字节、超时／并发、事件过滤／取消／重连、接入回滚、上下文权限、TSFN throw／reject／队列满、显式关闭和 Worker 环境销毁。测试 feature 使用两个同源生成的 Fixture／PeerFixture service；不读取业务数据，不启动 Electron。

`ts/test/stream.test.ts` 和 `rust/tests/stream.rs` 验证惰性 typed 流、模拟 SSE、单流并发、取消／drop、owner／caller 清理、分阶段可控时钟、配额和主动队列。native 流测试覆盖 TS→Rust、Rust 本地、A→main→B、有序 PB bytes、生产错误、pending open／next 取消、句柄归属及实际 producer 计数归零。`StreamMethod` 的生成漂移检查和两端编译反例验证方法种类与 chunk 类型。

Storage 联调额外构建正式 `xiaowei-storage` addon，`ts/test/native/storage.test.ts` 验证 TS 与另一 Rust addon 经同一 host 访问同一个数据库，覆盖 JSON null／缺失、字面前缀、非法 JSON、SQL 查询和重新打开后的持久化。全部使用临时文件，Storage 不加入 fixture feature。

## Electron 集成验收

`electron/` 保存真实 contextBridge 验收脚本及 preload／renderer 测试资产。依赖由本目录的私有 workspace 包 `@xiaowei/gateway-tests` 声明，不再借用 desktop 的依赖。

`pnpm --filter @xiaowei/gateway-tests build:electron` 只构建测试资产并输出临时目录。`electron/run.mjs` 仍需在已有 Electron 主进程的调试会话中导入并调用 `run(directory)`；执行前构建 Gateway dist 和原生 fixture，沿用现有验收流程。它创建隔离测试窗口，结束后清理，不属于 `pnpm test` 自动执行范围。
