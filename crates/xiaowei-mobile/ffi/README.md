# xiaowei-mobile-ffi

[`xiaowei-mobile`](../README.md) 的 UniFFI 适配层。Swift 与 Kotlin 使用同一组 Rust 功能和资源 owner；本层只导出对象、转换边界类型和生成绑定，不直接组合 xw-api、持久化登录态或实现账号规则。

## 构建与生成

在仓库根运行：

```sh
cargo build --locked -p xiaowei-mobile-ffi --features bindgen
cargo build --locked -p xiaowei-mobile-ffi --lib
target/debug/generate-mobile-bindings generate \
  target/debug/libxiaowei_mobile_ffi.dylib \
  --language swift --language kotlin \
  --out-dir target/mobile-bindings/generated --no-format
```

UniFFI 固定为 0.32.2，`uniffi.toml` 由生成器自动发现，不作为新版全局 `--config` 传入。`bindgen` feature 只供 host 工具使用；运行库默认不包含 cargo metadata 或 CLI。产物、编译缓存和生成绑定均在 target，不手改生成代码。

Swift 模块为 XiaoweiMobile，C 模块为 XiaoweiMobileFFI；Kotlin package 为 `xiaowei.mobile`，加载库为 `xiaowei_mobile_ffi`。业务消息当前仍以 PB 字节传递，Swift 映射 Data，Kotlin 映射 ByteArray。完整账号数据仅用于受信任的平台账号层，不进入连接事件或日志。

## 方法名与资源释放

| Rust 功能接口 | Swift／Kotlin 绑定 | 用途 |
| --- | --- | --- |
| `set_session` | 异步 `setSession` | 等待旧目标操作结算后应用已提交上下文，返回维护时间 |
| 客户端／操作／调用 `close` | `shutdown` | 等待实际任务、会话及网络资源清理 |
| 客户端 `suspend` | `pause` | 等待暂停，不与 Kotlin 关键字混淆 |
| 订阅 `close` | `stop` | 同步结束状态等待 |

Kotlin 生成器自带 AutoCloseable.close，只释放绑定引用，与异步业务清理职责不同。先对客户端、账号操作和 API 调用等待 `shutdown()`，对订阅调用 `stop()`，再调用生成对象的 `close()` 释放引用。Swift ARC 在相同的显式清理步骤之后回收对象。

任务取消分别通过 Swift `withTaskCancellationHandler` 或 Kotlin 协程清理调用 `cancel()`。账号操作还须在独立 Swift Task 或受控 NonCancellable 区域等待 `settledResult()`，接收并保存已轮换的凭据，然后 shutdown。不要只取消跨语言等待，或让 GC 代替凭据收取。

## 双语言验证

```sh
node crates/xiaowei-mobile/ffi/scripts/verify-bindings.mjs
```

入口当前支持 macOS arm64，需要本机 Rust、Swift、Go、Node、curl、tar 和 unzip。JDK 21.0.13+9、Kotlin 编译器 2.1.20、JNA 5.17.0 与 coroutines 1.10.2 固定版本及 SHA-256，下载到仓库 `target/mobile-bindings/tools/`；不修改系统 Java、PATH、全局工具安装或用户配置。仅子进程使用专属 JAVA_HOME 和库路径。

脚本先编译功能／绑定库与生成器，再以 Swift 6 严格并发、warnings-as-errors 编译 Swift，编译 Kotlin/JVM 协程调用。两端分别连接隔离 HTTP 与既有 Go WebSocket race fixture，核对 WS 认证／调用、公开 HTTP 无凭据、PB 业务失败、重复读取不重放、执行前取消、超时、执行中取消、检查点取消后保留凭据、用户更新、登录退出、订阅结束及整体关闭。服务端请求计数和 socket 关闭信号用于确认结果，不访问真实账号或启动 App。

## iOS 库验证

安装与当前 Rust 版本对应的目标后，在仓库根运行：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cargo build --locked -p xiaowei-mobile-ffi --lib --target aarch64-apple-ios
cargo build --locked -p xiaowei-mobile-ffi --lib --target aarch64-apple-ios-sim
```

重复验证静态库、Swift SDK 编译及实际链接使用：

```sh
node crates/xiaowei-mobile/ffi/scripts/verify-ios.mjs
```

该入口为真机与模拟器分别设置 SDKROOT 和测试用 iOS 15.0 deployment target，保证 Rust 的 C／汇编依赖与 Swift 使用一致的 SDK 和版本；Swift 严格并发检查及 linker warnings 均作为失败处理。此配置只用于库验收，不代替正式 App 的最低系统版本决定。

iOS 使用各自 target 下的 `libxiaowei_mobile_ffi.a` 与同次生成的 Swift／C 绑定；正式工程接入时再组合 XCFramework、确定最低系统版本及签名。Android 接入时为目标 ABI 构建 `.so` 并验证 JNA 加载与平台生命周期。macOS 的 Kotlin/JVM 成功不表示 Android 已验收，静态库与 SDK 编译不表示移动 App 已完成真机验收。
