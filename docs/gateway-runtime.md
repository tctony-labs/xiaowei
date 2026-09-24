# Gateway 运行机制

本文维护 TS／Rust Gateway 的调用、生命周期和传输语义。工程入口见 [Gateway README](../gateway/README.md)，业务契约修改步骤见 [维护技能](../.agent/skills/maintain-gateway-contract/SKILL.md)。

## 调用与绑定

TS 使用契约包的 service descriptor：`bindHandlers(service, handlers)` 创建完整服务注册项；同一服务跨 owner 时显式使用第三个参数 `{ partial: true }`，只注册所提供的方法，默认模式仍要求所有 unary handler。`bindClient(service, client)` 推导 unary 方法的请求和返回类型。每个 handler 收到保留原调用权限的 client，嵌套调用应使用它。

Rust `binding::generate_methods(descriptor, types)` 消费契约的 `FileDescriptorSet`，由调用方提供 PB full name→已生成 Rust message 路径的映射，生成 unary 的 `Method<Req, Res>` 和 server streaming 的 `StreamMethod<Req, Chunk>` 常量；`Method::handler` 和 `Method::call` 提供通用服务端／客户端适配。它不生成消息或 codec，不把测试类型编入 runtime。`StreamMethod::handler`／`stream` 提供流绑定；类型上不提供 unary call。生成工具拒绝 client streaming。

route 名为 `package.Service.Method`，event 名为 message 的 PB full name。stream 通过独立的 stream API 执行，误用 unary 入口返回 `WRONG_METHOD_KIND`。现有字符串 ID 可使用两端 `parseId`／`parse_id` 显式转换为 bigint／u64。

控制版本和契约版本目前均为 1；每次调用检查 route 名、方法种类、输入／输出 message 名及版本。契约版本表示显式破坏性修订，不是 descriptor 指纹；兼容加字段不改变版本。实际消费端按 PB 解码，中转端原样转发字节；prost 消费后重新编码会丢弃未知字段，这不是转发端行为。

TS transport 返回普通 `{ ok: true, value } | { ok: false, error: { code, message } }`。本地 client 把失败包装为 `GatewayFailure`，传输不能依赖 Error 实例自定义字段。Rust 内部使用 `Result<Vec<u8>, GatewayError>`，适配器需映射为同一普通对象协议。错误至少区分未知 route、owner 不可用、参数错误、并发已满、超时、未授权、handler 错误；另有冲突、不兼容和方法种类错误。核心不记录业务 payload，未知异常使用固定错误信息。

## 注册与请求生命周期

TS main 持有唯一 `GatewayHost`；各 Rust 模块持有本地 `XwInvokeRegistry`。`registerOwner`／`register_owner` 在同一批次中验证 routes 和 events，全部有效后才替换原 owner。批内重复、跨 owner 重名或无效策略不产生半注册状态。

每次替换创建新实例。关闭旧句柄不会注销新实例；旧连接投递和迟到响应不作用于新实例。TS 注册可注入 dispatcher，Rust 未命中时调用注入的 remote invoker；入口 `dispatchLocal`／`dispatch_local` 永远不回退，避免转发环。目标 host 未找到 route 立即返回 `UNKNOWN_ROUTE`。

执行 owner 默认超时 30 秒、每 route 最多 32 个在途 handler，满载立即拒绝。转发端只跟踪 owner 生命周期，不再次限流或设置执行超时。超时或 owner 关闭会明确结束等待方；底层 handler 继续持有本实例的并发许可，直到真实完成。Rust 执行任务不因等待方超时而 abort，因此已启动并等待中的 `spawn_blocking` 工作不会提前释放许可。系统副作用不回滚，写操作不自动重试。

owner 重注册会使旧 pending 请求失败；新实例有独立执行状态，宿主不能把重注册当作取消旧系统任务的方法。

## 响应流

TS 原始 client 使用 `await client.stream(route, requestBytes, { signal })`；PB client 使用 `bindStreamClient(service, client)`，按方法调用后返回 typed `ResponseStream`。`bindStreamHandlers` 只生成 streaming 注册项，`bindHandlers` 只生成 unary 注册项，两者可合并后一次注册。handler 收到原权限 client 和 AbortSignal。Rust 使用生成的 `StreamMethod::stream` 返回 `TypedResponseStream<Chunk>`，实现 `Stream<Item = Result<Chunk, GatewayError>>`，并提供 `cancel()`／可克隆的 `cancel_handle()`；drop 也会发起取消。本地命中直接 poll Rust producer，不经 JS。

每流只允许一个在途 next；并行 next 返回 `CONCURRENCY_FULL`，不同流互不阻塞。open 不 poll producer，next 每次最多取一条；main 和 napi 不预读。流固定绑定原 owner 实例和 caller，上下文在嵌套开流中保留。跨 caller next／cancel 返回 `UNAUTHORIZED`；owner 替换不转移旧流，也不重试 next。

状态为 opening → active → ended／failed／cancelled。TS 在发送 open 前监听 abort；native 在同步入口登记 open ID，取消不必等待开流或 next 完成。迟到的 open 会丢弃 producer，取消记录随对应请求结束释放。自然 end 后 next 返回 done，错误／取消后 next reject；终态只发生一次。`for await` break／异常通过 return 取消，显式 cancel 幂等。服务端终态清理句柄表，client 保留自己的终态，不在服务端积累 tombstone。

控制版本为 1。入站 native open 成功为空 Buffer；native→host open 返回编码在 Buffer 中的 policy JSON，让 Rust caller 使用相同的 chunk／idle 限额；next 的二进制帧为单字节 `0`（end），或 `1 + 大端 u32 seq + 原始 PB chunk`，seq 从 0 开始；error 使用原有结构化错误通道。序号异常和耗尽终止流，不重放；stream 对象不跨 FFI。host 维护上下文 token，流 ID 本身不提供授权。

默认 policy 见 TS `DEFAULT_STREAM_POLICY` 和 Rust `StreamPolicy::default()`；owner 在 registration 的 `streamPolicy`／`stream_policy` 配置，native manifest 同步公布：

| 项目 | 默认值 | 可配置范围 |
| --- | --- | --- |
| 单 chunk PB 字节 | 1 MiB | 1–64 MiB |
| 主动队列项数／PB 字节 | 16／4 MiB | 1–4096 项／1–64 MiB |
| 每 owner／caller 活跃流 | 128／32 | 1–4096，native endpoint 另有 128 个句柄硬上限 |
| open timeout | 10 秒 | 1–2147483647 毫秒 |
| pending next 生产 idle | 60 秒 | 同上，只在等待生产时计时 |
| 无消费 idle | 60 秒 | 同上，只在等待下次 pull 时计时 |
| active 总时长 | 不限（0） | 0 或上述毫秒范围 |

流不使用 unary 的整次 30 秒超时。Rust 远端开流握手另有 10 秒传输期限；成功后使用 owner 返回的 chunk／idle policy，不再套用默认生产期限。两端用可控时钟测试生产和消费方向，慢消费者不会触发生产 idle。

按 PB 编码后的长度计量；中转不解码或合并。typed adapter 每次只编码一条：Rust 先用 encoded_len 检查 64 MiB 硬上限，TS 编码前检查单个对象最多 65536 节点、64 层、64 MiB 字符串／bytes 预算（字符串按每 UTF-16 单元最多 3 字节计）。执行 policy 再约束实际 PB chunk。handler 不得预先缓存整个输出，Gateway 无法回收 handler 私自保存的对象或取消其任意外部任务。

主动源使用 `boundedByteQueue`／`bounded_byte_queue`，须 await send，满队列等待；TS 并发 send（未服从暂停）显式失败，Rust sender 不可克隆且 send 需要可变借用。队列内同时受项数和字节限额约束，队列外最多还有一个待发送 chunk 和一个正在交付的 chunk。普通 pull 源无此队列。消费者取消后关闭本地 reader／丢弃 Rust source；模拟 SSE 测试验证停止读取和关闭 reader，不依赖网络或模型密钥，也不保证远端模型停止生成或计费。

cancel 同步改变终态，再异步等待本地 producer 清理；显式清理最多等待 1 秒，超时明确报错。TS 不合作的 pending factory／next／return 保留 admission 到真实退出，不能靠取消绕过配额；Rust 丢弃所拥有的 source 和 future，主动生产任务须自行响应 channel 关闭／Drop。Rust 远端 source drop 发送独立、最多 1 秒的 best-effort cancel，本地 cancel 确认不等于远端外部副作用已撤销。native 环境退出只做本地关闭，不再调用 JS。caller cleanup、owner close 使 pending open／next 明确失败并清理对应状态。

## 事件

事件必须显式导出，filter 在源 owner 验证并匹配。TS 本地使用 `bindEvent`，远端使用含 `attach` 回调的 event export；中转层不解码 payload 或 filter。Rust 使用 `EventExportRegistration::typed` 和 `RemoteEvents` 的可注入 transport；业务通过 `Client::subscribe` 本地优先订阅。

Rust 本地和远端订阅须在 Tokio runtime 上下文中创建，投递队列保存该 runtime 的 handle；发布事件和 transport delivery 回调可从普通 OS 线程调用（如剪贴板监听线程），sink 始终调度到订阅时的 runtime。该 runtime 须在订阅存续期间保持运行。

每个订阅有自己的队列：Ordered 保留全部待投递事件，不用固定容量静默截断；Coalesce 替换为最后一个待投递状态；Drop 在已有待投递项时丢弃新项。正在执行的 sink 不算待投递项。事件是 best-effort、at-most-once；没有跨来源全序、历史补发或离线 payload 缓存。

普通本地订阅随源 owner 注销清理；显式 persistent 订阅只保留意图，源晚注册或替换后恢复。TS host 负责远端 owner 重新出现时重新 attach；Rust remote transport 替换时先使旧 delivery 闭包失效，再重建 persistent 订阅。transport 接入端须将 persistent 意图交给 host 管理，断开时调用 `set_transport(None)`。无效的晚到 filter 不会收到事件；调用者可关闭并重新订阅修正 filter。

订阅 handle 的 close 幂等；Rust handle drop 同样清理。caller cleanup 清理本地及远端订阅。连接替换、caller 销毁与异步 attach 完成竞态时，旧结果只清理自己的 lease；迟到失败也不能删除新 lease。transport 的 close 应只操作其绑定实例。

## 权限边界

宿主创建可信或精确白名单上下文；业务 payload 不能改变它。TS 上下文使用私有 WeakMap 校验，反序列化对象或复制 trusted 字段无效；client transport 不接受 caller 元数据。Rust 上下文不实现反序列化，字段私有。自有业务使用 trusted 上下文，无 route 白名单。

注册、发布、上下文构造是宿主 API，不能暴露给 renderer 或不可信入口。handler 的嵌套请求使用注入 client 保留权限。直接加载的 Rust／JS 模块拥有所在进程的权限，此机制不提供任意第三方代码的沙箱；native 适配只允许宿主传入上下文；Electron ingress 由已注册的主 frame 和宿主分配的会话提供上下文；任意第三方代码的隔离宿主尚未实现。


## 原生接入与关闭

`xw-gateway::napi::Endpoint` 持有业务传入的同一份 registry／owner；公共 crate 不注册 addon 导出或跨动态库 static。业务 napi 包负责薄封装和 endpoint 工厂，桌面装配见 [桌面 Gateway 接入](gateway-integration.md)。

宿主通过 `xiaowei-gateway/native` 的 `attachNative(host, name, endpoint, permissions?)` 接入。顺序为读取并校验 manifest → 预留全局 route／event 名称 → 绑定回调与来源上下文 → 激活 native → 原子发布。预留期间不暴露 route 或 event；失败会撤销预留并关闭新 endpoint，保留同名旧实例。返回的 handle 提供显式异步 `close()`；旧 handle 的关闭不会影响替换后的实例。

manifest 在 endpoint 生命周期内保持固定。运行中新增／删除 route 或 event 时，用包含新 manifest 的 endpoint 重新接入同一 owner；走相同预留与发布流程，不直接修改已经发布的 native registry。业务服务实例可通过 Arc 保持其独立生命周期，但每个 endpoint 对应自己登记的 owner 实例。

原生接口包括 manifest、bind、activate、dispatchLocal、streamControl、subscribeLocal、unsubscribeLocal、deliver、close。main→native 只执行 dispatchLocal；native 本地未命中才回调 host。host 若发现 fallback 目标仍在来源 manifest 内，返回未知 route，避免重新转发给来源。调用时的权限由 host 创建 opaque token 并保留原上下文，native 嵌套调用沿用该 token；PB payload 不参与授权。

控制 metadata／manifest 用 JSON 字符串，控制版本为 1；请求、响应、事件和 filter 的 PB 字节直接用 Buffer，不编码为 JSON 数组或 Base64。native Promise 成功返回 Buffer，失败返回序列化的 `{ code, message }` 字符串；TS adapter 将其恢复为核心 Result。native 控制响应（如订阅策略）也有明确的编码，不与业务 PB 混用。`streamControl(control, payload, context)` 执行 `stream.open`／`stream.next`／`stream.cancel`；stream ID 和 route 位于控制 JSON，chunk 仍是二进制。

TSFN 使用 non-blocking 投递，队列上限 64，并使用 `call_async_catch` 捕获同步 throw，再异步等待 JS Promise；拒绝值不会透传为业务内容。队列满返回 `CONCURRENCY_FULL`，关闭返回 `OWNER_UNAVAILABLE`，其他回调失败返回 `HANDLER_ERROR`。不持有 registry 或 endpoint 锁等待 JS，也不在 Node 主线程同步等待 Rust。现有同步业务仍需保持 spawn_blocking 适配。

napi 薄封装在同步入口克隆 Arc，再用 `Env::spawn_future` 返回 Promise；避免让 JS 对象的 `&self` 借用横跨异步任务与环境销毁。环境清理 hook 只保存 Weak 引用，退出时同步关闭本地状态、不再调用 JS。正常显式 close 会先使 pending 调用失败、释放订阅和 sink，再向 host 通知关闭；关闭确认最多等待 1 秒，投递失败或超时明确返回错误。JS GC 不替代显式 close；host 侧 handle.close 会同时清理路由、caller token 和订阅。

远端事件在 source／host 应用 filter 与队列策略，native 接收端对已经接受的投递使用 Ordered，避免重复 Drop／Coalesce 改变结果。订阅可早于 source 接入；owner 重连后恢复意图，不重放离线数据。异步订阅失败、取消和 endpoint 关闭都会释放本实例的本地 sink；迟到成功只清理其原 lease。

## Electron 接入

`xiaowei-gateway/electron` 的 `attachElectron(host, ipcMain)` 管理 main 侧会话；创建窗口后、加载页面前调用 `register(webContents)`。只有已注册窗口的主 frame 可连接，信任与权限由宿主提供；请求不能指定权限或目标窗口。`target(context)` 从 handler 第三个参数取得窗口，缺失或过期上下文明确失败。

preload 使用 `xiaowei-gateway/preload` 的 `createPreloadBridge(ipcRenderer)`，通过 contextBridge 暴露 `request`／`listen` 两个普通方法；renderer 使用 `xiaowei-gateway/renderer` 的 `createRendererClient(window.gateway)`。单一请求通道 `xiaowei:gateway` 承载 invoke、subscribe／unsubscribe、stream open／next／cancel；事件走私有通道并定向到所属 frame。AsyncIterator 只在 renderer 内创建，不跨 contextBridge。默认入口及 renderer 运行依赖不包含 Node、Electron 或原生包。

宿主分配 session／generation，导航、renderer 退出、窗口销毁时清理订阅和流。每会话最多 128 个订阅和 128 个流句柄；取消尚未 ready 的订阅后，初始化槽位保留到 attach 结束，迟到成功立即关闭。订阅先安装本地 listener，再等待远端 ready。流 open 不预取，cancel 和窗口销毁会取消实际 native producer；typed handler 返回的源在首次 next 前取消也会被释放。
