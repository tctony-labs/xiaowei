# Gateway

Gateway 提供环境无关的 TS host／client、Rust registry、Protobuf typed 绑定、响应流和事件，以及 TS ↔ Rust napi、Worker MessagePort 和 Electron IPC 通信适配层。业务消息由 [contracts](../contracts/README.md) 定义，具体 owner 由宿主装配。

## 工程入口

- [`ts/`](ts/README.md)：npm 包 `xiaowei-gateway`。默认入口提供 client、协议和绑定，`/host` 提供宿主管理；两者不依赖 Node／Electron。`/native` 使用 Node Buffer，`/worker-host` 与 `/worker` 提供 Node worker 两侧接入，`/electron`、`/preload`、`/renderer` 分别提供 Electron 各侧接入。
- [`rust/`](rust/README.md)：crate `xw-gateway`，默认纯 Rust；显式开启 `napi` feature 才编译 napi 通信适配层。
- [`tests/`](tests/README.md)：跨语言、原生模块和 Electron 验收入口。

TS 类型入口指向源码，工作区消费者必须通过 `source` 条件加载源码，Node 同时配置 TS loader；统一规则见 [Workspace 源码消费](../docs/workspace.md#workspace-源码消费)。默认 import 的 `dist/` 入口保留给本包构建产物验收。

## 接入约定

- 为 Gateway 提供 handler 实现及相关接入代码的模块统一命名为 `gateway`：TS 使用 `gateway.ts` 或 `gateway/`，Rust 使用 `gateway.rs` 或 `gateway/`，放在所属业务模块内。具体业务逻辑按能力归属组织，由 `gateway` 调用；仅使用 Gateway client 的模块不因此归入 `gateway`。该命名约定针对手写业务接入代码，不改变生成绑定的文件名。
- 使用契约 descriptor 和 typed client／handler；route 为 `package.Service.Method`，event 为消息的 Protobuf full name。
- owner 显式注册方法与事件；同一 service 可拆分到多个 owner，但每条 route 只能由一个 owner 发布。
- 宿主创建调用上下文；handler 的嵌套调用使用注入的 client 保留权限，不从业务 payload 构造身份。
- 接入、订阅和流的句柄由创建方负责关闭；替换 owner 不等于取消已发生的系统副作用。
- 修改业务契约或 Rust 模块 service 依赖时，按 [维护技能](../.agent/skills/maintain-gateway-contract/SKILL.md) 更新并生成绑定，生成文件不得手改。

## 开发与验证

从仓库根目录执行：

```sh
pnpm --filter xiaowei-gateway check
pnpm gateway:test
```

统一测试入口包含 Rust／TS 核心、worker 构建产物和 Rust napi 通信联调，不启动桌面；测试范围、产物恢复及 Electron 验收前提见 [测试说明](tests/README.md)。原生重建和运行实例操作遵循根 [AGENTS.md](../AGENTS.md)。

## 详细说明

- 语言侧 API 与实现约定：[TypeScript](ts/README.md)、[Rust](rust/README.md)。共同语义与线协议见下文。
- 桌面接入：[main 装配](../desktop/src/main/README.md#gateway-装配与生命周期)、[renderer 调用](../desktop/src/renderer/README.md#gateway-业务调用)及[构建与打包](../docs/workspace.md#桌面-gateway-通信)。
- [业务契约原则](../contracts/proto/xiaowei/README.md)：职责划分、消息语义和兼容性规则。
- [设计与实施记录](../.agent/records/active/2026-09-18-implement-gateway.md)：理由、取舍和验证结果。

## 调用与绑定

两端均使用 typed client／handler；具体绑定 API 见 [TS](ts/README.md#调用与绑定) 和 [Rust](rust/README.md#调用与绑定)。

route 名为 `package.Service.Method`，event 名为 message 的 PB full name。stream 通过独立的 stream API 执行，误用 unary 入口返回 `WRONG_METHOD_KIND`。现有字符串 ID 可使用两端 `parseId`／`parse_id` 显式转换为 bigint／u64。

控制版本和契约版本目前均为 1；每次调用检查 route 名、方法种类、输入／输出 message 名及版本。契约版本表示显式破坏性修订，不是 descriptor 指纹；兼容加字段不改变版本。实际消费端按 PB 解码，中转端原样转发字节；prost 消费后重新编码会丢弃未知字段，这不是转发端行为。

TS transport 返回普通 `{ ok: true, value } | { ok: false, error: { code, message } }`。本地 client 把失败包装为 `GatewayFailure`，传输不能依赖 Error 实例自定义字段。Rust 内部使用 `Result<Vec<u8>, GatewayError>`，适配器需映射为同一普通对象协议。错误至少区分未知 route、owner 不可用、参数错误、并发已满、超时、未授权、handler 错误；另有冲突、不兼容和方法种类错误。核心不记录业务 payload，未知异常使用固定错误信息。

## 注册与请求生命周期

TS main 持有唯一 `GatewayHost`；各 Rust 模块持有本地 `XwInvokeRegistry`；worker 仅持有固定本地 endpoint 与执行管理，不创建第二个 GatewayHost。`registerOwner`／`register_owner` 在同一批次中验证 routes 和 events，全部有效后才替换原 owner。批内重复、跨 owner 重名或无效策略不产生半注册状态。

每次替换创建新实例。关闭旧句柄不会注销新实例；旧连接投递和迟到响应不作用于新实例。TS 注册可注入 dispatcher，Rust 未命中时调用注入的 remote invoker；入口 `dispatchLocal`／`dispatch_local` 永远不回退，避免转发环。目标 host 未找到 route 立即返回 `UNKNOWN_ROUTE`。

执行 owner 按 route 限制在途 handler 并设置执行超时，满载立即拒绝；默认策略见 [TS execution](ts/src/core/execution.ts) 和 [Rust invoke](rust/src/invoke.rs)。转发端只跟踪 owner 生命周期，不再次限流或设置执行超时。超时或 owner 关闭会明确结束等待方；底层 handler 继续持有本实例的并发许可，直到真实完成。系统副作用不回滚，写操作不自动重试。

owner 重注册会使旧 pending 请求失败；新实例有独立执行状态，宿主不能把重注册当作取消旧系统任务的方法。

## 响应流

每流只允许一个在途 next；并行 next 返回 `CONCURRENCY_FULL`，不同流互不阻塞。open 不 poll producer，next 每次最多取一条；main 和 napi 不预读。流固定绑定原 owner 实例和 caller，上下文在嵌套开流中保留。跨 caller next／cancel 返回 `UNAUTHORIZED`；owner 替换不转移旧流，也不重试 next。

状态为 opening → active → ended／failed／cancelled。TS 在发送 open 前监听 abort；Rust napi 适配层在同步入口登记 open ID，取消不必等待开流或 next 完成。迟到的 open 会丢弃 producer，取消记录随对应请求结束释放。自然 end 后 next 返回 done，错误／取消后 next reject；终态只发生一次。`for await` break／异常通过 return 取消，显式 cancel 幂等。服务端终态清理句柄表，client 保留自己的终态，不在服务端积累 tombstone。

当前 TS／Rust 的活跃流默认并发上限如下；它限制同时占用执行名额的流数量，不是每秒请求数，超额开流返回 `RESOURCE_EXHAUSTED`，不排队。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxOwnerStreams`／`max_owner_streams` | 128 | 同一个服务 owner 的活跃流上限 |
| `maxCallerStreams`／`max_caller_streams` | 32 | 同一个调用方的活跃流上限 |

这两个数是实现时设置的框架资源保护默认值，当前没有记录对应的内存、连接数或吞吐量测算依据；不是 Pi、Node worker 或 napi 的技术要求，也不代表业务应采用的并发目标。它们不会根据负载自动调整。业务如需覆盖，应先明确资源预算和并发需求，而不是直接沿用或另选一组经验数字。

owner 可在 registration 的 `streamPolicy`／`stream_policy` 覆盖这些值，目前允许范围为 1–4096。统计位于实际执行环境；worker 内的上限不是跨所有 worker 的全局上限。取消／超时结束调用方等待，不代表尚未退出的执行立即释放名额。

完整默认值及校验规则见 [TS stream policy](ts/src/core/stream.ts) 和 [Rust StreamPolicy](rust/src/stream.rs)。限额还约束 chunk 字节、队列项数与字节及各阶段等待时间。TS ↔ Rust napi 接入会通过 manifest 公布 policy；[Rust napi 流句柄管理](rust/src/napi/streams.rs) 另有独立句柄硬上限，提高 service 并发配置并不保证整条调用链能承载同样数量的流。

流不使用 unary 的整次超时。开流握手、pending next 的生产 idle、等待下次 pull 的消费 idle，以及 active 总时长分别计时；慢消费者不会触发生产 idle。远端开流成功后使用 owner 返回的 chunk／idle policy。

按 PB 编码后的长度计量；中转不解码或合并，typed adapter 每次只编码一条，执行 policy 约束实际 PB chunk。handler 不得预先缓存整个输出；Gateway 无法回收 handler 私自保存的对象或取消其任意外部任务。

主动源使用有界队列，必须 await send，满队列等待。队列同时受项数与字节限制，队列外最多还有一个待发送 chunk 和一个正在交付的 chunk；普通 pull 源无此队列。消费者取消后关闭本地 reader／丢弃 source，不保证远端外部服务停止执行或计费。

cancel 同步改变终态，再异步等待本地 producer 清理；显式清理有期限，超时明确报错。caller cleanup、owner close 使 pending open／next 明确失败并清理对应状态。本地 cancel 确认不等于远端副作用撤销；具体语言的资源释放边界见各模块 README。

## 事件

事件必须显式导出，filter 在源 owner 验证并匹配；中转层不解码 payload 或 filter。

每个订阅有自己的队列：Ordered 保留全部待投递事件，不用固定容量静默截断；Coalesce 替换为最后一个待投递状态；Drop 在已有待投递项时丢弃新项。正在执行的 sink 不算待投递项。事件是 best-effort、at-most-once；没有跨来源全序、历史补发或离线 payload 缓存。

普通本地订阅随源 owner 注销清理；显式 persistent 订阅只保留意图，源晚注册或替换后恢复，不补发离线数据。无效的晚到 filter 不会收到事件；调用者可关闭并重新订阅修正 filter。

订阅 handle 的 close 幂等。caller cleanup 清理本地及远端订阅。连接替换、caller 销毁与异步 attach 完成竞态时，旧结果只清理自己的 lease；迟到失败也不能删除新 lease。transport 的 close 应只操作其绑定实例。

## 权限边界

项目自有代码默认使用 `trusted: true`，包括 renderer、Electron main、worker 和 Rust 模块。可信调用可访问已注册的业务 route 和事件，不配置逐 route 白名单，也不因调用方位于 renderer 或 worker 而增加 backend-only、宿主专用或调用方身份限制。只有用户明确要求权限控制或配置白名单时，才为指定范围设置限制；不得因新增服务或接口涉及凭据而自行添加授权层。

默认可信不免除参数与业务校验、事务约束、流／订阅句柄归属检查及生命周期管理。窗口身份用于定向操作和资源清理，不作为限制自有业务调用的依据。业务分层是职责划分，不等于权限划分。

Gateway 保留不可信调用方的精确白名单能力；显式启用后，调用／开流与事件订阅分别按授权范围检查。自有代码默认可信的约定不意味着未来网络入口免认证，也不意味着自动导出所有本地能力。

宿主创建可信或精确白名单上下文；业务 payload 不能改变它，上下文不能通过反序列化或复制字段伪造。

注册、发布、上下文构造是宿主 API，不能暴露给 renderer 或不可信入口。handler 的嵌套请求使用注入 client 保留权限。直接加载的 Rust／JS 模块拥有所在进程的权限，此机制不提供任意第三方代码的沙箱；native 适配只允许宿主传入上下文；Electron ingress 由已注册的主 frame 和宿主分配的会话提供上下文；任意第三方代码的隔离宿主尚未实现。

## TS 与 Rust 的 napi 通信协议

该适配层通过 napi 连接同一进程中的 TS 与 Rust `.node` 模块，不是网络传输或线程间消息通道。代码入口为 `xiaowei-gateway/rust-napi` 的 `attachRustNapi`，endpoint 类型为 `RustNapiEndpoint`；文件名、导出与文档统一明确标注 Rust napi 边界。

manifest 在 endpoint 生命周期内保持固定。运行中新增／删除 route 或 event 时，用包含新 manifest 的 endpoint 重新接入同一 owner；走相同预留与发布流程，不直接修改已经发布的 native registry。业务服务实例可通过 Arc 保持其独立生命周期，但每个 endpoint 对应自己登记的 owner 实例。

原生接口包括 manifest、bind、activate、dispatchLocal、streamControl、subscribeLocal、unsubscribeLocal、deliver、close。main→native 只执行 dispatchLocal；native 本地未命中才回调 host。host 若发现 fallback 目标仍在来源 manifest 内，返回未知 route，避免重新转发给来源。调用时的权限由 host 创建 opaque token 并保留原上下文，native 嵌套调用沿用该 token；PB payload 不参与授权。

控制 metadata／manifest 用 JSON 字符串，控制版本为 1；请求、响应、事件和 filter 的 PB 字节直接用 Buffer，不编码为 JSON 数组或 Base64。native Promise 成功返回 Buffer，失败返回序列化的 `{ code, message }` 字符串；TS adapter 将其恢复为核心 Result。native 控制响应（如订阅策略）也有明确的编码，不与业务 PB 混用。`streamControl(control, payload, context)` 执行 `stream.open`／`stream.next`／`stream.cancel`；stream ID 和 route 位于控制 JSON，chunk 仍是二进制。

控制版本为 1。入站 native open 成功为空 Buffer；native→host open 返回编码在 Buffer 中的 policy JSON，让 Rust caller 使用相同的 chunk／idle 限额；next 的二进制帧为单字节 `0`（end），或 `1 + 大端 u32 seq + 原始 PB chunk`，seq 从 0 开始；error 使用原有结构化错误通道。序号异常和耗尽终止流，不重放；stream 对象不跨 FFI。host 维护上下文 token，流 ID 本身不提供授权。

## Worker 线程通信

Worker MessagePort 通信适配层通过专用 Node Worker 的 parentPort 连接 main 与 worker，不使用 napi，也不跨 Electron contextBridge。它支持 unary、响应流和保留来源权限的嵌套调用；事件能力暂不支持。接入、策略及关闭说明见 [TS Worker 接入](ts/README.md#worker-messageport-通信适配层)。

service handler、执行配额、执行超时、AbortController、iterator 和实际清理归 worker；main 保留全局路由、授权、owner 生命周期及通信等待。worker 与 main 本地 handler 复用环境无关的 `ExecutionScope`，远端流通过独立 `StreamDispatcher` 接口挂载，main 不重复执行流 admission 或 producer 状态机。通信关闭并不提前释放仍在执行的 worker 任务许可。
