# Gateway 核心

Gateway 提供环境无关的 TS host／client、Rust 本地 registry、PB 调用绑定和事件 transport 接口。产品尚未接入；napi、Electron 适配和响应 stream 执行尚未实现。设计背景与实施进展见 [主事项](../.agent/records/active/2026-09-18-implement-gateway.md)。

## 工程入口

- `ts/`：`xiaowei-gateway`，默认入口提供 client、协议和契约绑定；`xiaowei-gateway/host` 提供宿主管理 API。两者目前都不依赖 Node／Electron。编译到 `dist/` 后通过 runtime／types exports 使用。
- `rust/`：`xw-gateway`，默认纯 Rust；没有 napi／Tauri 依赖。宿主持有 registry 的 `Arc`，向业务注入带调用上下文的 `Client`。
- `tests/wire-cases.json`：两端共同使用的有效／无效 PB 样例。`ts/test/transport.test.ts` 启动测试 CLI 验证 TS→Rust 和 Rust→TS；该 CLI 不是产品 sidecar，JSON 数字数组仅用于测试进程的帧封装。

```sh
pnpm --filter xiaowei-gateway check
pnpm --filter xiaowei-gateway test
pnpm --filter xiaowei-gateway build
cargo test -p xw-gateway --no-default-features
```

`just check` 包含 Rust 核心检查和 TS 类型检查；`just test` 包含上述测试。核心测试使用 fake transport，无需启动桌面或构建 napi 包。

## 调用与绑定

TS 使用契约包的 service descriptor：`bindHandlers(service, handlers)` 创建注册项；`bindClient(service, client)` 推导 unary 方法的请求和返回类型。每个 handler 收到保留原调用权限的 client，嵌套调用应使用它。

Rust `binding::generate_methods(descriptor, types)` 消费契约的 `FileDescriptorSet`，由调用方提供 PB full name→已生成 Rust message 路径的映射，生成 `Method<Req, Res>` 常量；`Method::handler` 和 `Method::call` 提供通用服务端／客户端适配。它不生成消息或 codec，不把测试类型编入 runtime。生成工具识别 server streaming、拒绝 client streaming，避免与未实现的方法种类混淆。

测试绑定可用以下命令更新；Rust 测试比较生成内容以发现漂移：

```sh
cargo run -q -p xw-gateway --example generate_fixture > gateway/rust/tests/fixture_bindings.rs
```

route 名为 `package.Service.Method`，event 名为 message 的 PB full name。stream descriptor 可以登记，但 unary 入口返回 `WRONG_METHOD_KIND`，不执行 stream。现有字符串 ID 可使用两端 `parseId`／`parse_id` 显式转换为 bigint／u64。

控制版本和契约版本目前均为 1；每次调用检查 route 名、方法种类、输入／输出 message 名及版本。契约版本表示显式破坏性修订，不是 descriptor 指纹；兼容加字段不改变版本。实际消费端按 PB 解码，中转端原样转发字节；prost 消费后重新编码会丢弃未知字段，这不是转发端行为。

TS transport 返回普通 `{ ok: true, value } | { ok: false, error: { code, message } }`。本地 client 把失败包装为 `GatewayFailure`，传输不能依赖 Error 实例自定义字段。Rust 内部使用 `Result<Vec<u8>, GatewayError>`，适配器需映射为同一普通对象协议。错误至少区分未知 route、owner 不可用、参数错误、并发已满、超时、未授权、handler 错误；另有冲突、不兼容和方法种类错误。核心不记录业务 payload，未知异常使用固定错误信息。

## 注册与请求生命周期

TS main 将持有唯一 `GatewayHost`；各 Rust 模块持有本地 `XwInvokeRegistry`。`registerOwner`／`register_owner` 在同一批次中验证 routes 和 events，全部有效后才替换原 owner。批内重复、跨 owner 重名或无效策略不产生半注册状态。

每次替换创建新实例。关闭旧句柄不会注销新实例；旧连接投递和迟到响应不作用于新实例。TS 注册可注入 dispatcher，Rust 未命中时调用注入的 remote invoker；入口 `dispatchLocal`／`dispatch_local` 永远不回退，避免转发环。目标 host 未找到 route 立即返回 `UNKNOWN_ROUTE`。

执行 owner 默认超时 30 秒、每 route 最多 32 个在途 handler，满载立即拒绝。转发端只跟踪 owner 生命周期，不再次限流或设置执行超时。超时或 owner 关闭会明确结束等待方；底层 handler 继续持有本实例的并发许可，直到真实完成。Rust 执行任务不因等待方超时而 abort，因此已启动并等待中的 `spawn_blocking` 工作不会提前释放许可。系统副作用不回滚，写操作不自动重试。

owner 重注册会使旧 pending 请求失败；新实例有独立执行状态，宿主不能把重注册当作取消旧系统任务的方法。

## 事件

事件必须显式导出，filter 在源 owner 验证并匹配。TS 本地使用 `bindEvent`，远端使用含 `attach` 回调的 event export；中转层不解码 payload 或 filter。Rust 使用 `EventExportRegistration::typed` 和 `RemoteEvents` 的可注入 transport；业务通过 `Client::subscribe` 本地优先订阅。

每个订阅有自己的队列：Ordered 保留全部待投递事件，不用固定容量静默截断；Coalesce 替换为最后一个待投递状态；Drop 在已有待投递项时丢弃新项。正在执行的 sink 不算待投递项。事件是 best-effort、at-most-once；没有跨来源全序、历史补发或离线 payload 缓存。

普通本地订阅随源 owner 注销清理；显式 persistent 订阅只保留意图，源晚注册或替换后恢复。TS host 负责远端 owner 重新出现时重新 attach；Rust remote transport 替换时先使旧 delivery 闭包失效，再重建 persistent 订阅。transport 接入端须将 persistent 意图交给 host 管理，断开时调用 `set_transport(None)`。无效的晚到 filter 不会收到事件；调用者可关闭并重新订阅修正 filter。

订阅 handle 的 close 幂等；Rust handle drop 同样清理。caller cleanup 清理本地及远端订阅。连接替换、caller 销毁与异步 attach 完成竞态时，旧结果只清理自己的 lease；迟到失败也不能删除新 lease。transport 的 close 应只操作其绑定实例。

## 权限边界

宿主创建可信或精确白名单上下文；业务 payload 不能改变它。TS 上下文使用私有 WeakMap 校验，反序列化对象或复制 trusted 字段无效；client transport 不接受 caller 元数据。Rust 上下文不实现反序列化，字段私有。自有业务使用 trusted 上下文，无 route 白名单。

注册、发布、上下文构造是宿主 API，不能暴露给 renderer 或不可信入口。handler 的嵌套请求使用注入 client 保留权限。直接加载的 Rust／JS 模块拥有所在进程的权限，此机制不提供任意第三方代码的沙箱；隔离宿主及 Electron／napi ingress 尚未实现。
