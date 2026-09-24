# Gateway

Gateway 提供环境无关的 TS host／client、Rust registry、Protobuf typed 绑定、响应流和事件，以及 napi／Electron 传输适配。业务消息由 [contracts](../contracts/README.md) 定义，具体 owner 由宿主装配。

## 工程入口

- [`ts/`](ts/README.md)：npm 包 `xiaowei-gateway`。默认入口提供 client、协议和绑定，`/host` 提供宿主管理；两者不依赖 Node／Electron。`/native` 使用 Node Buffer，`/electron`、`/preload`、`/renderer` 分别提供 Electron 各侧接入。
- [`rust/`](rust/README.md)：crate `xw-gateway`，默认纯 Rust；显式开启 `napi` feature 才编译原生适配。
- [`tests/`](tests/README.md)：跨语言、原生模块和 Electron 验收入口。

TS 类型入口指向源码，支持 `source` 条件的构建器可以直接消费源码；普通 Node 默认 import 指向 `dist/`，使用前需要构建。

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
pnpm --filter xiaowei-gateway test
pnpm --filter xiaowei-gateway build
cargo test -p xw-gateway --no-default-features
```

核心测试无需启动桌面或构建 napi 包。原生跨模块验证使用 `pnpm gateway:test-native`；测试范围、产物恢复及 Electron 验收前提见 [测试说明](tests/README.md)。原生重建和运行实例操作遵循根 [AGENTS.md](../AGENTS.md)。

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

TS main 持有唯一 `GatewayHost`；各 Rust 模块持有本地 `XwInvokeRegistry`。`registerOwner`／`register_owner` 在同一批次中验证 routes 和 events，全部有效后才替换原 owner。批内重复、跨 owner 重名或无效策略不产生半注册状态。

每次替换创建新实例。关闭旧句柄不会注销新实例；旧连接投递和迟到响应不作用于新实例。TS 注册可注入 dispatcher，Rust 未命中时调用注入的 remote invoker；入口 `dispatchLocal`／`dispatch_local` 永远不回退，避免转发环。目标 host 未找到 route 立即返回 `UNKNOWN_ROUTE`。

执行 owner 按 route 限制在途 handler 并设置执行超时，满载立即拒绝；默认策略见 [TS registry](ts/src/core/registry.ts) 和 [Rust invoke](rust/src/invoke.rs)。转发端只跟踪 owner 生命周期，不再次限流或设置执行超时。超时或 owner 关闭会明确结束等待方；底层 handler 继续持有本实例的并发许可，直到真实完成。系统副作用不回滚，写操作不自动重试。

owner 重注册会使旧 pending 请求失败；新实例有独立执行状态，宿主不能把重注册当作取消旧系统任务的方法。

## 响应流

每流只允许一个在途 next；并行 next 返回 `CONCURRENCY_FULL`，不同流互不阻塞。open 不 poll producer，next 每次最多取一条；main 和 napi 不预读。流固定绑定原 owner 实例和 caller，上下文在嵌套开流中保留。跨 caller next／cancel 返回 `UNAUTHORIZED`；owner 替换不转移旧流，也不重试 next。

状态为 opening → active → ended／failed／cancelled。TS 在发送 open 前监听 abort；native 在同步入口登记 open ID，取消不必等待开流或 next 完成。迟到的 open 会丢弃 producer，取消记录随对应请求结束释放。自然 end 后 next 返回 done，错误／取消后 next reject；终态只发生一次。`for await` break／异常通过 return 取消，显式 cancel 幂等。服务端终态清理句柄表，client 保留自己的终态，不在服务端积累 tombstone。

默认值及可配置范围见 [TS stream policy](ts/src/core/stream.ts) 和 [Rust StreamPolicy](rust/src/stream.rs)。owner 在 registration 的 `streamPolicy`／`stream_policy` 配置，native manifest 同步公布；原生句柄硬上限以 [native streams](rust/src/napi/streams.rs) 为准。限额分别约束 chunk 字节、队列项数与字节、owner／caller 活跃流数及各阶段等待时间。

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

宿主创建可信或精确白名单上下文；业务 payload 不能改变它，上下文不能通过反序列化或复制字段伪造。

注册、发布、上下文构造是宿主 API，不能暴露给 renderer 或不可信入口。handler 的嵌套请求使用注入 client 保留权限。直接加载的 Rust／JS 模块拥有所在进程的权限，此机制不提供任意第三方代码的沙箱；native 适配只允许宿主传入上下文；Electron ingress 由已注册的主 frame 和宿主分配的会话提供上下文；任意第三方代码的隔离宿主尚未实现。

## 原生传输协议

manifest 在 endpoint 生命周期内保持固定。运行中新增／删除 route 或 event 时，用包含新 manifest 的 endpoint 重新接入同一 owner；走相同预留与发布流程，不直接修改已经发布的 native registry。业务服务实例可通过 Arc 保持其独立生命周期，但每个 endpoint 对应自己登记的 owner 实例。

原生接口包括 manifest、bind、activate、dispatchLocal、streamControl、subscribeLocal、unsubscribeLocal、deliver、close。main→native 只执行 dispatchLocal；native 本地未命中才回调 host。host 若发现 fallback 目标仍在来源 manifest 内，返回未知 route，避免重新转发给来源。调用时的权限由 host 创建 opaque token 并保留原上下文，native 嵌套调用沿用该 token；PB payload 不参与授权。

控制 metadata／manifest 用 JSON 字符串，控制版本为 1；请求、响应、事件和 filter 的 PB 字节直接用 Buffer，不编码为 JSON 数组或 Base64。native Promise 成功返回 Buffer，失败返回序列化的 `{ code, message }` 字符串；TS adapter 将其恢复为核心 Result。native 控制响应（如订阅策略）也有明确的编码，不与业务 PB 混用。`streamControl(control, payload, context)` 执行 `stream.open`／`stream.next`／`stream.cancel`；stream ID 和 route 位于控制 JSON，chunk 仍是二进制。

控制版本为 1。入站 native open 成功为空 Buffer；native→host open 返回编码在 Buffer 中的 policy JSON，让 Rust caller 使用相同的 chunk／idle 限额；next 的二进制帧为单字节 `0`（end），或 `1 + 大端 u32 seq + 原始 PB chunk`，seq 从 0 开始；error 使用原有结构化错误通道。序号异常和耗尽终止流，不重放；stream 对象不跨 FFI。host 维护上下文 token，流 ID 本身不提供授权。
