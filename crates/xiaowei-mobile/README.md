# xiaowei-mobile

iOS 与 Android 共用的 Rust 功能入口。当前组合 `xw-api` 的网络与账号会话能力，提供统一客户端、账号操作句柄、普通 API 调用、连接订阅、取消和关闭。模块负责运行时与资源生命周期；可复用业务规则仍在 `xw-*`，不依赖 UniFFI、Swift、JVM、Gateway 或桌面。

平台宿主经 [`ffi/`](ffi/README.md) 使用生成的 Swift／Kotlin 绑定，自行维护产品登录态、系统存储、设备信息与平台生命周期。[iOS App](../../ios/README.md) 已接入最小连接与前后台生命周期；Keychain／Keystore、产品账号和设备配对尚未实现。

## 准备与验证

使用工作区锁定的 Rust 工具链，在仓库根运行：

```sh
cargo test --locked -p xiaowei-mobile
node crates/xiaowei-mobile/ffi/scripts/verify-bindings.mjs
```

Rust 集成测试使用隔离的本地 HTTP 服务；跨语言入口另使用既有 Go WebSocket race fixture，需要 Swift／Go 与下载工具链的网络。测试不访问用户账号，不启动桌面或移动 App。

## 接口与接入

- [统一 API、账号检查点与生命周期](docs/interfaces.md)
- [Swift／Kotlin 生成、验证与移动库构建](ffi/README.md)
- [共享网络与会话核心](../xw-api/README.md)

`MobileClient::new()` 在模块内部初始化网络与运行环境。宿主通过 `set_session` 交付已提交的会话，使用账号操作的 `run`／`resume`／`settled_result` 处理凭据，再显式关闭操作；整体退出时调用 `MobileClient::close`。业务消息以现有服务器 proto 为唯一来源，当前边界传递 PB 字节，不维护第二套业务消息。
