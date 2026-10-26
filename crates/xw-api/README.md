# xw-api

纯 Rust 的小微客户端网络与账号会话核心。HTTP 使用 reqwest/rustls，认证 WebSocket 使用 Tokio/rustls；`account` 模块处理单服务器认证与会话维护。整个 crate 不依赖 Gateway、napi、Electron 或平台 UI，也不提供存储接口。契约来自 `proto-server-rs` 的原始 descriptor，以标准 Proto JSON／二进制 PB 编解码。

## 网络调用

`Client::new()` 创建具体客户端；`RequestContext` 为每次调用提供不可变的服务器、会话、时间、选项和取消信号。`invoke` 处理已发布的服务端方法，typed login／refresh／current_user／logout 提供 Rust 接口。调用不保存或自动刷新凭据，不提交产品登录态；宿主必须显式关闭 Client。

`Connection::set_target` 只配置宿主已提交的当前会话，替换凭据取消旧代次。连接提供鉴权等待、安全状态观察、15 秒心跳和有抖动的退避重连；鉴权拒绝后等待新凭据。断线不回放请求，WS 已发出后不经 HTTP 重试。`websocket::Peer` 提供网络作用域的请求关联、事件应答与 pull 流，客户端导出为空，不反向调用 App 内部 Gateway。

## 账号会话

`account::SessionCore` 直接使用同一 crate 的具体 `Client`，提供登录、传入会话恢复、维护、退出和未提交登录撤销；账号能力不经 Gateway 调用网络层，也不提供 SessionStore 接口。

宿主自行加载会话并调用 `activate`；`connect` 决定是否活动化该服务器的连接。`suspend` 取消工作并停止当前连接；恢复时重新传入宿主选定的会话，不维持移动后台网络。`close` 可重复调用并等待本核心在途操作退出，不关闭其他消费者共享的 Client。服务器列表、产品登录态、文件与 Keychain、UI 状态和定时器均归宿主。

`start` 接收操作 ID、操作、当前时间、宿主已有权限和取消信号。默认 Access 允许独立原生客户端调用；桌面适配从原 Gateway caller 提取四项 Auth 权限，每一步仅在确实需要该动作时检查，不注入认证 API 或 client 工厂。5 分钟提前刷新、并发轮换合并、WS 鉴权／HTTP 确认和最多一次强制恢复都在本模块执行。

恢复／退出中的刷新成功后，结果以 `checkpoint = true` 返回完整新凭据与递增版本，停止在下一次网络动作之前。宿主接受凭据后，使用同一操作 ID 调用 `resume`。该确认不规定保存位置或策略；桌面继续按原顺序先保留内存、再保存文件、最后继续验证。保存失败则取消本次操作并先重试保存，不能重放已消费的 refresh token。

错误和取消的结果仍包含已接受的最新凭据。取消后用 `settled_outcome` 等待操作真正结束并读取最后结果；不要只依赖成功响应取得轮换结果。操作 ID、目标代次和版本隔离迟到结果；更换目标不能将新目标凭据交给旧操作。请求在服务端已提交但客户端未取得响应时，仍可能需要重新登录，不承诺撤销远端副作用。

## 接入与验证

桌面适配位于 `xiaowei-rust/napi/src/xwapi/` 和 `xiaowei-rust/napi/src/account/`，由 Rust 集成层创建具体 Client 并组合会话核心，TS 无需创建或传入 api 原生实例。同一个 GatewayEndpoint 注册 Auth／Health 和安全连接事件；AccountService 经固定 napi 方法调用会话核心。普通服务器调用读取 Rust 持有的当前宿主上下文，临时目标从独立宿主操作取得。凭据不广播到事件或 AccountSnapshot。隔离操作有独立的短生命周期核心，退出未激活服务器不会替换当前连接。TS AccountService／AccountStore 继续唯一维护桌面登录态与持久化。

[account.proto](../../contracts/proto/xiaowei/desktop/account.proto) 仅是桌面内部的产品契约，使用自己的展示与表单消息；共享会话能力使用本 crate 的普通 Rust 接口，不定义 account-session 或 xwapi proto。认证消息和业务错误码来自服务器契约，调用选项为普通 Rust `RequestOptions`／`Transport`。移动端后续通过自己的 FFI 出口使用本 crate；移动绑定、系统存储和前后台行为尚未接入。HTTP／WS 的生产线协议说明见 [服务端 WebSocket](../../server/docs/websocket.md)。

```sh
cargo test --locked -p xw-api
```

测试使用真实本地 HTTP 和 Go race fixture，不访问用户账号；需要 Go 工具链。网络测试覆盖标准 Proto JSON、64 位值、地址规则、限额、重定向、超时、取消、通知、流、重连与代次隔离。`tests/account/` 覆盖提前刷新、并发、检查点、轮换后错误／取消、身份核对、权限、退出、暂停与目标替换。桌面正式 napi 的 Gateway、存储兼容、保存失败、多服务器、UI 快照、补偿及日志回归由 `pnpm --dir desktop test` 执行，该入口也执行本 crate 的测试。目标平台需要 Tokio 网络／时钟支持和系统联网权限；Apple ATS／前后台及 Android 生命周期由对应平台宿主接入时验收。
