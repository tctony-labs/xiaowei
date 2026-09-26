# Gateway 共享验收

`wire-cases.json` 由 Rust `tests/core.rs` 和 TS `test/core.test.ts` 共同执行，覆盖空 PB message、uint64 上限和损坏 wire。复杂 optional／oneof／2 MiB bytes 往返使用 `testing.Fixture` 契约，在 TS `test/transport.test.ts` 与 Rust `examples/fixture_transport.rs` 间执行；测试 service 不向产品注册。

Rust `tests/core.rs` 覆盖注册、typed 参数、远端回退、并发、filter、Ordered burst、backend 订阅保留／解绑、旧连接投递和 owner 清理语义，以及批内重名、跨 routes／events 原子性、超时后真实任务占用、连接替换与迟到结果、白名单及协议兼容测试。两端有编译期错误入参／返回值反例。

统一入口为 `pnpm gateway:test`（等价于 Gateway TS 包的 `test`）。`run.mjs` 依次执行 Rust 核心／文档测试、TS 核心与 worker 测试、构建后 plain Node 测试，以及 `ts/test/rust-napi/` 的真实 Rust napi 通信联调。不会构建 desktop 或运行业务测试，也不启动 Electron。

通信联调通过共享的 `scripts/tests/rust-napi-fixtures.mjs` 为搜索、剪贴板构建 `gateway-fixtures`，产物位于忽略的 `target/rust-napi-tests/`；finally 尝试恢复每个包的正式 `.node`、JS 加载器和类型声明，并检查正式包不含测试导出。构建、测试、恢复或产物检查失败均使命令失败。Gateway 与 desktop 的测试入口不可并行执行或与这些包的构建重叠；根测试按 workspace 顺序执行。

TS ↔ Rust napi 通信测试覆盖本地优先、双向调用、重入、PB 大字节、超时／并发、事件过滤／取消／重连、接入回滚、上下文权限、TSFN throw／reject／队列满、显式关闭和 Worker 环境销毁。测试 feature 使用两个同源生成的 Fixture／PeerFixture service。

`ts/test/stream.test.ts` 和 `rust/tests/stream.rs` 验证惰性 typed 流、模拟 SSE、单流并发、取消／drop、owner／caller 清理、分阶段可控时钟、配额和主动队列。napi 跨语言流测试覆盖 TS→Rust、Rust 本地、A→main→B、有序 PB bytes、生产错误、pending open／next 取消、句柄归属及实际 producer 计数归零。`StreamMethod` 的生成漂移检查和两端编译反例验证方法种类与 chunk 类型。

Storage、搜索／剪贴板业务、LLM 和桌面装配测试归 [desktop/tests](../../desktop/tests/README.md)，由 desktop 的统一 `test` 入口运行。

## Worker 验证

`ts/test/worker.test.ts` 使用真实 Node Worker，验证 typed handler 的线程归属、交错流、执行配额、超时后仍占许可、pending open／next／return 的取消、权限回传和子流寿命、CPU 阻塞下 main 继续响应、错误／退出／替换、损坏帧与 token 拒绝、传输表及 payload 上限。控制门闩走独立测试 MessagePort，不把测试信号混入 Gateway 协议。门闩释放与业务请求经过不同端口，iterator 的 returned 通知也早于框架配额清理；释放后的可用性断言仅对对应的配额占满错误进行最多 5 秒的等待重试，其他错误立即失败，配额未释放也会失败。释放前仍直接断言配额占满，不能用重试掩盖提前释放。

`ts/test/worker-built.test.mjs` 由统一入口在构建后运行，再由 plain Node 消费 `/worker-host` 和 `/worker` 导出，验证实际 dist 路径及 PB 字节往返；该模式不加载 tsx，也不启用 `source`；其他源码测试显式启用 `source`，不依赖它生成的 dist。源码 fixture 由单次 `tsx/esm/api` 的 tsImport 加载，保持 binding、endpoint 与 GatewayFailure 的模块身份一致。

`ts/test/rust-napi/worker.test.ts` 在上述 fixture addon 构建窗口执行 Rust typed caller → napi → main → Worker 联调；验证多段 PB 顺序、部分数据后失败、pending next 取消和 worker 退出，不修改业务 proto 或 Rust 生产源码。

## 更新测试绑定

从仓库根目录使用以下命令更新测试绑定；Rust 测试比较生成内容以发现漂移：

```sh
cargo run -q -p xw-gateway --example generate_fixture > gateway/rust/tests/fixture_bindings.rs
```

## Electron 集成验收

`electron/` 保存真实 contextBridge 验收脚本及 preload／renderer 测试资产。依赖由本目录的私有 workspace 包 `@xiaowei/gateway-tests` 声明。

`pnpm --filter @xiaowei/gateway-tests build:electron` 只构建测试资产并输出临时目录。main／preload／renderer 均内联 Gateway 源码，无需 Gateway dist。在已有 Electron 主进程的调试会话中导入输出目录的 `main.mjs` 并调用 `run(directory)`；执行前构建原生 fixture 和正式 Storage addon。main 资产中的原生包与 fixture 路径固定到生成它的 checkout，移动 checkout 后需重新构建。它创建隔离测试窗口，结束后清理，不属于 `pnpm test` 自动执行范围。
