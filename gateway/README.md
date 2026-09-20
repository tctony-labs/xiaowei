# Gateway 核心

Gateway 提供环境无关的 TS host／client、Rust 本地 registry、PB 调用绑定、事件和 napi 传输适配。产品业务通信尚未迁移；Electron 适配和响应 stream 执行尚未实现。设计背景与实施进展见 [主事项](../.agent/records/active/2026-09-18-implement-gateway.md)。

## 工程入口

- `ts/`：`xiaowei-gateway`，默认入口提供 client、协议和契约绑定；`xiaowei-gateway/host` 提供宿主管理 API。默认入口和 host 不依赖 Node／Electron；`xiaowei-gateway/native` 是使用 Node Buffer 的原生接入入口。编译到 `dist/` 后通过 runtime／types exports 使用。
- `rust/`：`xw-gateway`，默认纯 Rust，不依赖 napi／Tauri；显式开启 `napi` feature 才编译原生适配。宿主持有 registry 的 `Arc`，向业务注入带调用上下文的 `Client`。
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

注册、发布、上下文构造是宿主 API，不能暴露给 renderer 或不可信入口。handler 的嵌套请求使用注入 client 保留权限。直接加载的 Rust／JS 模块拥有所在进程的权限，此机制不提供任意第三方代码的沙箱；native 适配只允许宿主传入上下文；隔离宿主及 Electron ingress 尚未实现。


## 原生接入与关闭

`xw-gateway::napi::Endpoint` 持有业务传入的同一份 registry／owner；公共 crate 不注册 addon 导出或跨动态库 static。搜索与剪贴板的 napi 包分别导出 `GatewayEndpoint` 薄封装及 `createGatewayEndpoint()`，每次创建有独立 registry。当前正式工厂只创建空 endpoint，保留原业务 API；实际业务 handler 尚未迁入。

宿主通过 `xiaowei-gateway/native` 的 `attachNative(host, name, endpoint, permissions?)` 接入。顺序为读取并校验 manifest → 预留全局 route／event 名称 → 绑定回调与来源上下文 → 激活 native → 原子发布。预留期间不暴露 route 或 event；失败会撤销预留并关闭新 endpoint，保留同名旧实例。返回的 handle 提供显式异步 `close()`；旧 handle 的关闭不会影响替换后的实例。

manifest 在 endpoint 生命周期内保持固定。运行中新增／删除 route 或 event 时，用包含新 manifest 的 endpoint 重新接入同一 owner；走相同预留与发布流程，不直接修改已经发布的 native registry。业务服务实例可通过 Arc 保持其独立生命周期，但每个 endpoint 对应自己登记的 owner 实例。

原生接口包括 manifest、bind、activate、dispatchLocal、subscribeLocal、unsubscribeLocal、deliver、close。main→native 只执行 dispatchLocal；native 本地未命中才回调 host。host 若发现 fallback 目标仍在来源 manifest 内，返回未知 route，避免重新转发给来源。调用时的权限由 host 创建 opaque token 并保留原上下文，native 嵌套调用沿用该 token；PB payload 不参与授权。

控制 metadata／manifest 用 JSON 字符串，控制版本为 1；请求、响应、事件和 filter 的 PB 字节直接用 Buffer，不编码为 JSON 数组或 Base64。native Promise 成功返回 Buffer，失败返回序列化的 `{ code, message }` 字符串；TS adapter 将其恢复为核心 Result。native 控制响应（如订阅策略）也有明确的编码，不与业务 PB 混用。声明保留 `stream.open`／`stream.next`／`stream.cancel` 操作名称；当前返回方法种类错误，尚无 stream 执行和流控。

TSFN 使用 non-blocking 投递，队列上限 64，并使用 `call_async_catch` 捕获同步 throw，再异步等待 JS Promise；拒绝值不会透传为业务内容。队列满返回 `CONCURRENCY_FULL`，关闭返回 `OWNER_UNAVAILABLE`，其他回调失败返回 `HANDLER_ERROR`。不持有 registry 或 endpoint 锁等待 JS，也不在 Node 主线程同步等待 Rust。现有同步业务仍需保持 spawn_blocking 适配。

napi 薄封装在同步入口克隆 Arc，再用 `Env::spawn_future` 返回 Promise；避免让 JS 对象的 `&self` 借用横跨异步任务与环境销毁。环境清理 hook 只保存 Weak 引用，退出时同步关闭本地状态、不再调用 JS。正常显式 close 会先使 pending 调用失败、释放订阅和 sink，再向 host 通知关闭；关闭确认最多等待 1 秒，投递失败或超时明确返回错误。JS GC 不替代显式 close；host 侧 handle.close 会同时清理路由、caller token 和订阅。

远端事件在 source／host 应用 filter 与队列策略，native 接收端对已经接受的投递使用 Ordered，避免重复 Drop／Coalesce 改变结果。订阅可早于 source 接入；owner 重连后恢复意图，不重放离线数据。异步订阅失败、取消和 endpoint 关闭都会释放本实例的本地 sink；迟到成功只清理其原 lease。

## 原生联调

```sh
pnpm gateway:test-native
```

该命令为搜索和剪贴板启用 `gateway-fixtures`，构建到忽略的 `gateway/tests/native/`，在普通 Node 进程中加载两个真实 `.node`。测试契约 `testing.Fixture`／`testing.PeerFixture` 只在该 feature 中注册；正常构建没有 fixture 工厂、方法或测试 routes。测试不创建业务 Service，不访问用户数据库或系统剪贴板。

测试脚本退出前总会重新执行两个包的正常 `build:debug`，生成正式 `.node`、JS 加载器及声明。源码中的 napi 注解决定公开类型，生成声明不手改；TS 类型检查同时验证两个生成 endpoint 类型与 NativeEndpoint 接口兼容。

修改原生源码后须完成上述构建，并按工作区运行实例规则执行 `just rs`，已加载的 `.node` 不会自动替换。`just test` 运行常规核心／业务回归；`pnpm gateway:test-native` 是需要构建测试 feature 的独立联调入口。
