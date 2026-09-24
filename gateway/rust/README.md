# Gateway Rust

本模块提供纯 Rust registry、typed 绑定、事件和响应流；napi 适配由 feature 显式开启。共同语义与线协议见 [Gateway](../README.md)，原生模块构建与所有权约定见 [crates README](../../crates/README.md)。

## 调用与绑定

Rust `binding::generate_methods(descriptor, types)` 消费契约的 `FileDescriptorSet`，由调用方提供 PB full name→已生成 Rust message 路径的映射，生成 unary 的 `Method<Req, Res>` 和 server streaming 的 `StreamMethod<Req, Chunk>` 常量；`Method::handler` 和 `Method::call` 提供通用服务端／客户端适配。它不生成消息或 codec，不把测试类型编入 runtime。`StreamMethod::handler`／`stream` 提供流绑定；类型上不提供 unary call。生成工具拒绝 client streaming。

## 响应流

Rust 使用生成的 `StreamMethod::stream` 返回 `TypedResponseStream<Chunk>`，实现 `Stream<Item = Result<Chunk, GatewayError>>`，并提供 `cancel()`／可克隆的 `cancel_handle()`；drop 也会发起取消。本地命中直接 poll Rust producer，不经 JS。

编码前使用 encoded_len 检查硬上限；限额见 [stream.rs](src/stream.rs)。`bounded_byte_queue` 的 sender 不可克隆，send 需要可变借用。

取消时丢弃所拥有的 source 和 future；主动生产任务须自行响应 channel 关闭／Drop。远端 source drop 发送独立且有超时的 best-effort cancel；远端开流握手也有独立传输期限，成功后使用 owner 返回的 policy。

## 事件与 runtime

Rust 使用 `EventExportRegistration::typed` 和 `RemoteEvents` 的可注入 transport；业务通过 `Client::subscribe` 本地优先订阅。

Rust 本地和远端订阅须在 Tokio runtime 上下文中创建，投递队列保存该 runtime 的 handle；发布事件和 transport delivery 回调可从普通 OS 线程调用（如剪贴板监听线程），sink 始终调度到订阅时的 runtime。该 runtime 须在订阅存续期间保持运行。

remote transport 替换时先使旧 delivery 闭包失效，再重建 persistent 订阅；接入端将 persistent 意图交给 host 管理，断开时调用 `set_transport(None)`。订阅 handle drop 同样清理。

上下文字段私有且不实现反序列化；业务不得从 payload 构造权限。

## napi 通信接入与关闭

`xw-gateway::napi::Endpoint` 持有业务传入的同一份 registry／owner；公共 crate 不注册 addon 导出或跨动态库 static。业务 napi 包负责薄封装和 endpoint 工厂，桌面装配见 [main 装配与生命周期](../../desktop/src/main/README.md#gateway-装配与生命周期)。

业务服务可通过 Arc 保持独立生命周期，但每个 endpoint 对应自己的 owner 实例；manifest 与原子发布约定见 [共同协议](../README.md#ts-与-rust-的-napi-通信协议)。

## 实现易错点

Rust 执行任务不因等待方超时而 abort；已启动并等待中的 `spawn_blocking` 工作继续持有并发许可，直到真实完成。

TSFN 使用 non-blocking 投递，队列有界，并使用 `call_async_catch` 捕获同步 throw，再异步等待 JS Promise；拒绝值不会透传为业务内容。队列满返回 `CONCURRENCY_FULL`，关闭返回 `OWNER_UNAVAILABLE`，其他回调失败返回 `HANDLER_ERROR`。不持有 registry 或 endpoint 锁等待 JS，也不在 Node 主线程同步等待 Rust。现有同步业务仍需保持 spawn_blocking 适配。

napi 薄封装在同步入口克隆 Arc，再用 `Env::spawn_future` 返回 Promise；避免让 JS 对象的 `&self` 借用横跨异步任务与环境销毁。环境清理 hook 只保存 Weak 引用，退出时同步关闭本地状态、不再调用 JS。正常显式 close 会先使 pending 调用失败、释放订阅和 sink，再向 host 通知关闭；关闭确认有超时限制，投递失败或超时明确返回错误。JS GC 不替代显式 close；host 侧 handle.close 会同时清理路由、caller token 和订阅。

远端事件在 source／host 应用 filter 与队列策略，native 接收端对已经接受的投递使用 Ordered，避免重复 Drop／Coalesce 改变结果。订阅可早于 source 接入；owner 重连后恢复意图，不重放离线数据。异步订阅失败、取消和 endpoint 关闭都会释放本实例的本地 sink；迟到成功只清理其原 lease。
