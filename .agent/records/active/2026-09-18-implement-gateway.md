# 实现核心 Gateway 通信机制

## Why

目前 Electron 使用业务专用 IPC 接口，renderer、main 和独立 Rust 原生模块之间缺少统一寻址和调用方式。随着模块间调用增多，需要一个独立的核心通信机制，使调用方不必了解服务所在的模块／进程。

多个 `.node` 即使依赖同一个 Rust crate，也不会自动共享 registry 或内存实例，需要显式的本地注册和跨模块路由。

## What

从 `xiaowei-next` 提取 gateway，作为独立的核心通信机制，统一跨进程 IPC 和进程内 RPC，覆盖 renderer、main 和 Rust 模块。Gateway 不依赖具体应用模块，也不包含数据库、配置或其他业务逻辑。调用权限按可信／不可信划分，不按 renderer／backend 划分。

应用模块通过 Gateway 暴露能力；搜索、剪贴板及后续的 [Storage](../proposed/2026-09-18-introduce-storage.md) 都是调用方／服务提供方。Gateway 不依赖 Storage，也不是它的专用桥接层。

本事项已实现三语言契约工程、核心／绑定、napi 适配、响应流及 Electron 业务通信迁移。搜索、剪贴板和窗口操作已经通过 Gateway 接入，直接使用生成的 typed client 并保留既有 UI 行为。自动化及真实 Electron 边界验证已通过；用户完成本轮试用后反馈整体未发现问题，本轮人工验收收尾。Storage 保持独立事项。当前契约见 [契约说明](../../../contracts/README.md)，运行时和 Electron 接入见 [Gateway](../../../gateway/README.md)。

## How

### 当前核心实现

已实现的协议、注册／请求生命周期、事件、napi 接入与权限边界集中维护在 [Gateway 核心](../../../gateway/README.md)。纯 Rust 核心、TS host、两个真实 `.node` 间的 TSFN／Promise 链路及 Electron contextBridge 已通过测试。下文保留设计边界；当前接口和生产路由以 Gateway 文档及代码为准。

### 统一服务调用

按全局服务名注册 handler，调用方使用 `route + payload`，不绑定具体实现位置。沿用旧版 `XwInvokeRegistry`、`XwEventRegistry`、`xwInvoke`、`xwOn` 的模型：本地命中时直接调用 handler，未命中时通过传输适配层路由到 owner。

进程内 RPC 与跨进程 IPC 共用寻址、协议和生命周期；本地调用不必绕行 Electron IPC 或 socket。保留服务名称冲突检查、按 owner 注册／注销、handler 超时与并发限制，以及显式事件导出和订阅清理。

Electron main 可作为当前多个 `.node` 模块之间的路由中心：原生模块注册服务，并通过适配层获得调用其他服务的能力。每个服务实例由明确的 owner 持有，不因其他模块依赖同一 crate 而重复创建。具体 napi 回调和服务启动顺序在实施前细化，不要求合并现有原生包，也不因此引入新的子进程。

### 接口定义与绑定生成：Protobuf 适配方向

Gateway 保留 invoke、event、stream 三类契约及 route 寻址。先用成熟的 Protobuf 消息定义与生成工具适配现有传输，不再自研 JSON 类型 DSL，也不引入完整 gRPC 网络运行时或直接接入 Mojo。独立适配验证、Plan 00 的正式消息／接口描述生成和 Plan 01 的 Gateway 核心及通用绑定已完成。

使用 `contracts/proto/**/*.proto` 定义消息、unary RPC 和 server-streaming RPC。TS 使用 Protobuf-ES，Rust 使用 prost／prost-build；它们生成消息类型与二进制 codec。TS 可直接利用生成的 service descriptor 创建 typed client，Rust 的 Gateway 生成适配消费契约包的原生 FileDescriptorSet 和 PB full name→Rust message 路径映射，生成 typed Method 常量，再复用通用 client／handler adapter。该适配不修改 contracts 的消息生成器。我们只补通信绑定，不重写 Protobuf 类型生成器，不生成业务实现。

同一份消息定义支持 optional、oneof、数组和嵌套 bytes。验证中 uint64 映射为 TS bigint／Rust u64，bytes 为 Uint8Array／Vec<u8>；展示模型的字符串 ID 在页面边界显式转换，通信调用直接使用生成消息。Proto3 optional 表达缺失与默认值，不天然表达缺失／null／值三态；确有需求时在 proto 中显式定义 oneof／NullValue。Protobuf 编解码负责 wire 格式，业务范围、长度、权限和领域校验仍由运行时／handler 负责，不能把生成类型说成完整校验器。

Event 的最低契约就是稳定名称和对应 message。验证使用 message 的 Protobuf full name 作为名称，TS descriptor 与 Rust `prost::Name` 同源生成，无须额外 RPC 或手写两份常量；只有显式导出的 message 才成为事件。需要 filter 时再定义 filter message。若保留 `clipboard.changed` 等业务别名，应从同一份元数据生成映射，具体采用 proto option 还是同源注册描述在正式接入前确定；不为命名再造一套类型 DSL。

契约集中为独立的 `contracts/` 工程，由对应业务维护 proto，客户端和服务端共同依赖，不再各自在 desktop／业务 crate 复制生成类型。契约包不依赖 Gateway、不包含业务实现或具体传输。

```text
contracts/
  proto/                 # 唯一手写来源；common 与业务分目录，本地不加 v1
  ts/                    # TS npm 契约包：生成类型、codec、接口描述
    package.json
  rust/                  # Rust 契约 crate：生成类型、codec、接口描述
    Cargo.toml
  go/                    # Go 契约 module：生成类型、codec、接口描述
    go.mod
  ...                    # 统一的生成配置与工具入口
```

Electron／React／未来 RN 使用 TS 契约包，Rust 业务使用 Rust crate，Go 服务端使用 Go module。包名、module path、消费方式与生成入口已在 Plan 00 确定，见 [契约说明](../../../contracts/README.md)。契约工程是共享接口产物，不是第三套 Gateway 实现；Gateway 的 TS／Rust 两包结构保持不变。本地 proto package 与目录均不预设 `v1`；涉及服务端的契约以后再按兼容需求决定版本命名空间。业务目录可以 import common，common 不依赖业务；按实际规模拆文件，不强制 types／service／events 三文件。

通用 protoc／Protobuf-ES／prost／Go 生成编排归 `contracts/` 管理。`xiaowei-gateway` 只保留 Gateway 特有的 client／handler 绑定适配，消费语言契约中的 service descriptor；不把业务定义写进 Gateway 核心。调用方和服务提供方使用相同契约；如果后续其他 transport 需要专用 stub／server interface，也从同一 proto 生成，不复制消息定义。

正式工具已提供 `pnpm contracts:generate`、只读的 `pnpm contracts:check` 和 `pnpm contracts:test`，产物入库且禁止手改，固定工具版本并检测缺失／过期／多余产物。生成检查接入 `just check`，跨语言 codec 测试接入 `just test`。具体工具版本、跨项目 protoc 缓存和平台支持见 [契约说明](../../../contracts/README.md)。napi-rs 继续生成 endpoint／生命周期 API 的 JS 加载器和声明，与业务 PB 绑定分工。早期探针仅验证过 TS／Rust；Plan 00 已完成正式 Go 生成及三语言往返。探针不属于交付内容，正式工具不依赖其目录或产物。

协议兼容遵循 Protobuf 字段编号和版本规则；控制协议版本、route kind 和可接受的接口版本需要运行时明确检查。旧计划的“任意 schema 指纹不同就拒绝”不能直接沿用为 PB 默认策略，正式接入前需区分兼容加字段和破坏性变更。生成漂移检查与运行时兼容检查是两件事。prost 会丢弃 typed decode／encode 后的未知字段，Gateway 中转层必须原样转发 PB 字节，只在实际调用与执行端解码。

流控和取消由 Gateway 两端运行时实现，不必写进每个业务 `.proto`。`returns (stream Chunk)` 只声明结果形态，不会自动带来 gRPC 的流控、取消或状态机。内部 open／next／cancel、句柄归属、错误与终态仍须统一约定并版本化；目前不要求把这些控制操作暴露为业务 RPC。双方代码可以实现该约定，但不能各自采用不兼容语义。

### Protobuf 适配验证结果

临时验证代码与复现步骤保存在本地 `experiments/gateway-protobuf/`，该目录被 Git 忽略，不属于仓库交付内容，也不是后续实施的必需依赖；验证结论保留在本 record。实验使用独立 pnpm／Cargo 工程，没有更改主应用依赖，没有启动桌面或修改用户数据。

使用 protoc 36.0、Protobuf-ES 2.15.0、prost／prost-build 0.14.4。TS 类型检查及 10 项自动测试通过：两端方法名称／流标记一致；typed unary；uint64 最大值、optional 和 oneof；嵌套 bytes／2 MiB 字节往返；事件名称及 payload；惰性 pull、提前 break 取消、正常终态、pending next 中取消；非法 wire／业务参数拒绝；未知字段行为。

这证明 PB 消息与 service 定义可绑定到自定义 transport，不依赖 gRPC 运行时。Rust CLI 仅经 stdin／stdout 交换测试字节，不是产品 sidecar；流生命周期使用可控 TS ByteSource，尚未验证真实 Rust 常驻 producer、TSFN、Electron IPC／contextBridge 或 HTTP SSE。生产级 client／handler 生成、全链路背压、取消与资源限额仍按各 Plan 实施，不能据本实验宣称 Gateway 已完成。

### Stream 契约与传输

当前已实现。API、状态机、默认 policy／可配置范围和计量方式统一维护在 [Gateway 核心：响应流](../../../gateway/README.md#响应流)。下面保留设计边界；renderer 的导航、销毁和取消生命周期已接入。

LLM SSE 场景使用请求绑定的响应 stream；SSE 解析和结构化增量由业务提供，Gateway 不理解 HTTP／SSE。此次实现通用流能力及模拟生产者，不新增实际 LLM provider、网络请求或聊天 UI。

```ts
const stream = await gateway.stream("llm.generate", request, { signal });
try {
  for await (const chunk of stream) {
    // chunk 类型由契约生成，例如文本增量或工具调用增量。
  }
} finally {
  await stream.cancel(); // 已结束时为幂等空操作。
}
```

上例的 route 仅说明后续用法，不在产品中注册占位的 `llm.generate`。TS 返回 `AsyncIterable` 与幂等 `cancel()`；Rust 返回带取消句柄的 typed `Stream<Item = Result<Chunk, GatewayError>>`。`for await` 提前 break／抛错通过 iterator.return 发起取消；显式 signal 中止同样取消。Rust drop 触发尽力取消，需要等待释放时使用显式异步 cancel。

首版采用 pull 模式，不先实现可转交端点的通用双向 pipe：

| 控制操作 | 行为 |
| --- | --- |
| `stream.open` | 校验契约和权限，绑定 caller／owner 实例，分配 stream ID；只建立流句柄，不向消费者抢先推送 chunk |
| `stream.next` | 每流最多一个在途 pull；返回一个带 seq 的 chunk、正常 end 或结构化 error。main 路由至原 owner，不重新按 route 寻找替代实例 |
| `stream.cancel` | 独立于 pending next 发送，取消生产者及在途 next，并幂等释放句柄；开流尚未完成时可按 open request ID 中止 |

`open → active → ended / failed / cancelled`，终态只发生一次；正常结束不是错误，失败后的消费获得明确错误，已交付 chunk 不撤回。终态消费规则由 client 保持，不为了幂等无限保留服务端 tombstone。序号仅在单条流内递增，不能自动重试 next；序号异常或传输失败终止流，不承诺重连续传／exactly-once。未消费的历史不在 Gateway 中持久化。

pull 是端到端背压：消费者调用 next 才拉取下一项；main 和 napi 不另开后台 drain 或无界队列。本地 Rust 调用也使用同样的惰性流语义。业务若必须桥接主动生产者，只能使用有界队列并在达到限额时停止读取上游；同时限制 chunk 大小、缓冲项数、字节总量、每 owner／caller 活跃流数。超出单块限制或上游无法暂停且缓冲耗尽时显式失败并取消，不能丢弃／合并增量，也不能无限缓存。具体限额作为 owner 注册的 stream policy，在实施切片中明确默认值并测试。

背压最多传播到应用的 HTTP 读取，不保证远端 LLM 停止生成或停止计费。取消通过业务 cancellation token 关闭本地 HTTP 请求和 reader；无法中断的外部副作用不能声称已撤销。

执行 owner 分别管理开流超时、待拉取数据时的生产超时、消费者长期不拉取的空闲期限及可选总时长。普通 invoke 默认 30 秒不能直接套作整条流总时长；没有 pull 时不得误算生产者超时，但不能无限保留被遗弃的流。流占用的并发／资源额度保留至生产者真实退出，不能每个 next 都当成新的独立业务调用。

窗口导航／重载／销毁、owner 注销、native 环境关闭均取消相关流。main 维护 caller 与 owner 实例关联，stream ID 不能作为任意调用方均可使用的凭据；可信调用免白名单，不免除句柄归属检查。不可信 caller 的开流按 route 白名单授权，next／cancel 只可操作自己已授权建立的流。取消不得受满载的数据队列阻塞，也不得等待当前 next 返回才能处理。

Electron／napi 仅传普通请求、结果、stream ID 和字节；AsyncIterator、JS class、Rust Stream 对象不直接跨 contextBridge 或 IPC。iterator 在 renderer 的 client 内创建，preload 只暴露 open／next／cancel transport 方法。napi endpoint 用异步方法完成同样的控制操作；不能持有 registry 锁等待流项，也不能在 pending next 中占有 cancel 所需的锁。

### Renderer 接入与访问边界

```text
Renderer: xwInvoke("clipboard.list", { query })
    → preload → Electron IPC
    → gateway → 剪贴板 owner → 业务 handler
```

上图为业务调用示例，存储实现不属于 Gateway。只保留 `window.gateway` 通用 transport，页面使用 lazy getter 获得生成的 typed service client；不保留 `window.clipboardHistory` 等旧 facade。

renderer 使用 `xwOn("clipboard.changed", handler)` 订阅事件。gateway 按实际窗口／frame 投递，在取消订阅、窗口销毁或重载时清理订阅。沿用旧版 best-effort、at-most-once 事件语义；可靠恢复通过重新读取快照或专门的历史接口实现。

调用方分为两类：

- 可信：不做 IPC 调用授权或白名单检查。当前调用方均为自有业务，包括 renderer、Electron main 和 Rust 模块，默认可信。
- 不可信：需要显式授权对应的 IPC 白名单，只允许调用已授权的 route；未授权的调用拒绝执行。

信任分类由宿主接入层确定，不通过业务 payload 自报。当前不为自有业务增加逐 route 授权配置；未来接入不可信调用方时显式标记并配置白名单。可信调用不做授权检查，不影响接口参数校验、业务校验、事务约束或订阅生命周期管理。

上图展示通过业务服务查询数据的常用链路，不是 renderer 的权限限制。可信 renderer 可以调用任意已注册的业务 route，不设置 backend-only 限制；涉及领域规则时仍应使用业务服务，避免重复实现业务逻辑。

### 远端服务与双向 WebSocket（仅记录，暂不实现）

同一套 Gateway 调用方式可以覆盖远端 server。client／server 建立已认证的 WS 连接后，双方均可作为调用方和服务提供方，使用同一份 contracts 生成的 typed client 与 handler 接口。上层调用方式与本地服务一致，网络不可用、超时等结果仍明确返回，不伪装成本地调用必然成功。

```text
客户端 typed client → 客户端 Gateway → WS transport
    → 服务端 Gateway → 服务端业务 handler

服务端 typed client → 服务端 Gateway → 同一条 WS 连接
    → 客户端 Gateway → 客户端业务 handler
```

职责分层：

- Contracts：接口、消息、event payload 和 stream chunk 的共同定义及语言产物。
- Gateway：owner／route 注册、寻址、invoke／event／stream 和服务生命周期。
- WS transport／连接管理层：认证、连接状态、请求／响应关联、超时、断线清理，以及订阅、流取消和背压的跨网络传播。
- 业务 handler：业务处理，不各自建立 WS 或维护连接状态；依赖业务在线状态时通过连接层接口获知。

连接建立且完成认证、契约及服务发布协商后，将显式导出的远端服务挂到对应连接 owner；断开时撤销可用状态，使在途请求／流明确失败并清理订阅和资源。重连使用新的连接实例标识，旧响应／旧 stream ID 不得影响新连接；可重新发布服务和建立订阅，但不自动重试写操作、重放事件或恢复 LLM 流，可靠恢复需业务专门设计。

WS 是双向传输，不自动提供应用层 RPC、取消或背压；复用并扩展 Gateway 控制语义，仍需有界发送缓冲、独立取消路径和 owner／caller 关联。请求 ID 需区分连接实例及调用方向，具体帧格式、心跳、重连退避和流量控制映射在远端实施前细化。

本地自有模块默认可信的约定不延伸为网络免认证。远端导出的 route／event 应显式声明并进行会话授权，不能因为共享契约或建立 WS 就把本机所有服务暴露给服务器，或把 Storage 原始数据库接口公开给任意客户端。反向调用同样受导出范围和会话权限约束。

本地与远端的路由作用域必须区分：面向 server 的 client 绑定明确远端 owner／目标，不能把任意本地未命中调用自动发送到网络，也不能让同名服务覆盖本地 owner。具体目标选择和多连接命名规则后续确定。

本节只记录整体架构，不增加当前 Plan 的 WS、Go Gateway runtime 或服务端接入任务，不创建网络连接、不选择额外运行时。先完成本地 Electron IPC／napi 链路，远端 transport 另行计划。

### 后续本地 socket 接入（仅记录）

当前 renderer 与 main 的跨进程通信由 Electron IPC 承载；napi 连接同一进程中的 TS 与 Rust。当前没有自行实现本地进程通信的需求，不新增 socket transport、独立 worker／helper、占位实现或实施 Plan。

后续若需要独立本地进程接入，可为 Gateway 增加本地 socket transport，复用核心的契约、服务注册、路由、调用和事件／stream 语义。提供接入能力不意味着必须将现有原生业务模块改为子进程。

届时参考旧版 host／studio 的 Unix domain socket、BridgeHub 请求响应关联与心跳、enrollment 接入认证、broker 服务归属与订阅管理，以及连接 epoch 和断线清理机制；按实际运行平台与需求确定传输和协议适配，不直接搬入旧版部署结构。连接准入与业务调用授权分别处理，旧会话的响应和资源不得影响新连接。

### 旧版参考与迁移边界

参考仓库：`~/Develop/XiaoWei/workspace/src/xiaowei-next`。

- `docs/xw-gateway.md`：服务寻址、本地优先、事件与 owner 生命周期。
- `crates/xw-tauri/src/invoke.rs`：调用 registry、typed adapter、超时和并发限制。
- `crates/xw-tauri/src/event.rs`：事件 registry。
- `crates/xw-core/src/bridge/`：后续本地 socket 接入参考；`hub.rs` 管理收发与请求响应关联，`peer.rs`／`auth.rs` 管理接入认证，`protocol.rs` 定义旧版桥接协议。
- `xiaowei/src/api/xwIpc.ts`：前端调用和订阅封装。

提取与 Tauri 无关的机制，补 Electron／napi 适配及可信调用来源；不搬入旧版公司业务和私有依赖。host/studio socket、enrollment、多 peer 重连等机制待实际多进程需求出现后再评估，不把旧版完整部署结构作为本次前提。

## Alternatives considered

- 先合并为单一 `.node` 以共享内存状态：并非引入 gateway 的必要条件，当前不要求这样调整。
- 按 renderer／backend 设置固定权限边界：不采用。当前自有业务默认可信，未来不可信调用方按 IPC 白名单授权。

## 工程接入

### 工程结构

- `gateway/ts`：App 直接使用的 TS 包，提供绑定生成工具、协议、main registry／路由和调用／事件／stream 客户端封装；核心与默认入口不依赖 Electron，Electron 适配通过子路径入口隔离。按现有命名约定使用 `xiaowei-`。
- `gateway/rust`：Rust registry、typed handler、事件、stream 与传输接口；默认仅编译纯 Rust 核心，不依赖 Tauri、napi 或 Electron。napi 适配放在该 crate 的可选 `napi` feature 中，不另建 `xw-napi-gateway` 包。
- `desktop/src/main/gateway.ts` 和 `desktop/src/preload/gateway.ts`：调用 Gateway 的环境适配入口，负责应用实例装配与生命周期接线；业务调用改用生成消息与 lazy service getter。

Gateway 集中放在根目录 `gateway/`：`ts/` 是 npm 包，`rust/` 是 Cargo crate，`tests/` 保存跨语言集成测试，`README.md` 说明工程入口。pnpm 与 Cargo workspace 分别显式纳入 `gateway/ts`、`gateway/rust`；包名保持不变。通用契约及生成工具仍在根目录 `contracts/`。后续可增加 `gateway/go/`，本次只记录，不创建目录、占位包或 Go Gateway 实现；Plan 00 的 Go 契约生成范围保持不变。

### 两个包与运行实例

两个包共同组成一套 Gateway，不是两个独立通信系统，也不生成单独的 gateway `.node`。绑定生成与 stream 是在旧版 route／event 机制上新增的能力，属于本次明确扩展；底层仍复用 Electron IPC／napi，不直接接入 Mojo。

| 包／入口 | 使用方 | 负责内容 |
| --- | --- | --- |
| `xiaowei-gateway` 默认入口（TS） | 普通业务包，包括第三方 package | 环境无关的 client／handler 绑定、类型与 transport 接口；由宿主注入 client，不自行创建全局 host |
| `xiaowei-gateway/main` | Electron main | 装配 host、原生 endpoint 与 Electron ingress；全局路由核心保持环境无关、可独立测试 |
| `xiaowei-gateway/preload` | Electron preload | Electron IPC 与 contextBridge 桥接，不暴露底层 ipcRenderer 或宿主管理权限 |
| `xiaowei-gateway/renderer` | renderer | 基于 preload 通道创建 invoke／event／stream client，不维护全局路由表，不依赖 Node／Electron |
| `xw-gateway` 默认 feature（Rust） | 各 Rust 业务包 | 本地 registry、typed handler、事件及远端 transport 抽象 |
| `xw-gateway` 的 `napi` feature（Rust） | 各业务包的 napi 绑定 crate | TSFN／Promise、字节和错误转换、JS transport 接入及关闭；复用同一个 Rust registry |

```text
gateway/
  README.md
  ts/                  # npm 包 xiaowei-gateway
    package.json
    src/
      core/            # protocol、registry、client、stream
      binding/         # typed client／handler 适配
      main/            # native endpoint 与 Electron main 适配
      preload/         # IPC／contextBridge 桥接
      renderer/        # 浏览器侧 client 接入
  rust/                # crate xw-gateway
    Cargo.toml
    src/
      lib.rs
      protocol.rs
      invoke.rs
      event.rs
      binding.rs
      stream.rs
      napi/            # 可选 napi feature
  tests/               # 跨语言集成测试
```

Plan 01 实现环境无关的核心与绑定，Plan 02 添加 native 适配，Plan 04 添加 Electron 环境入口。第三方 package 是代码来源，不是运行环境或自动建立的安全边界；直接加载的 npm 依赖拥有所在进程的权限。不可信插件的隔离宿主与授权接入后续另行设计。

Rust 业务包依赖 `xw-gateway` 默认核心；其 `napi/Cargo.toml` 才开启 `features = ["napi"]`。该 feature 仅引入可选 napi 依赖；不把核心类型绑定到 JS 值或运行环境。纯 Rust 用例须可在未启用该 feature 时编译与测试。

每个业务模块显式持有自己的 registry 和服务实例，通过 `Arc` 传给其 napi endpoint；不能在业务层与适配层各创建一份 registry。搜索和剪贴板的 registry 分别位于各自 `.node`，不是进程共享 static。main 则只创建一个 host，接入这些 endpoint；renderer 只创建 client。

### 对外接入契约

以下为本轮接口职责，核心 Rust／TS 类型已在 Plan 01 落实，见 [Gateway 核心](../../../gateway/README.md)；native endpoint 与 `xiaowei-gateway/native` 的 attachNative 已实现；stream 和 Electron 接入均已实现。

| 接口 | 调用方与作用 |
| --- | --- |
| Rust `register_owner`／事件导出 | 业务模块注册自己的 typed handler 和可订阅事件；业务规则仍调用现有 Service |
| Rust `call`／`subscribe`／`publish`／`stream` | 业务模块调用或订阅服务，本地优先；不要求调用方知道 JS、Electron 或目标 `.node` |
| TS host `registerOwner` | main 注册窗口操作、文件打开等 TS handler |
| TS host `attachNative` | 读取 endpoint manifest，检查全局重名，绑定宿主分配的 owner 上下文和异步 transport；全部成功后对外发布 |
| TS host `call`／`subscribe`／`stream` | main 本地业务或 Electron ingress 调用统一入口，按 owner 分发 |
| TS client `invoke`／`on`／`stream`（由契约生成类型） | renderer 使用生成的 typed service client；不保留旧业务 facade |
| owner handle `close` | 停止接入并注销该实例的 routes／events／订阅，释放回调和在途请求；幂等，不能注销后续重新接入的新实例 |

各 `.node` 的 endpoint 提供 manifest、transport 绑定、本地 dispatch、事件订阅／取消、stream open／next／cancel 及关闭能力，统一由 `xiaowei-gateway/native` 的适配接入。公共适配实现位于 `xw-gateway::napi`；各业务 napi 包仅保留 `#[napi]` 导出薄封装，避免从公共 crate 隐式注册一套独立模块或全局实例。生命周期工厂继续由业务包导出，不能通过普通业务 route 创建任意服务实例。

### 实际调用链路

```text
renderer 调用 clipboard.list
  → TS client → preload → Electron IPC
  → main host 查询 owner
  → clipboard.node 的 endpoint.dispatchLocal
  → 剪贴板 registry → 已有 Service.list

Rust 模块调用自己的本地 route
  → 本模块 registry → handler（不进入 JS）

Rust 模块调用其他模块的 route
  → 本模块 registry 未命中
  → napi 异步 transport → main host 查询 owner
  → 目标 .node 的 endpoint.dispatchLocal → 目标 handler

main 调用自己的 TS route
  → main host → TS handler（不进入 Electron IPC）
```

事件由 owner 显式导出；同一 Rust registry 内的订阅直接投递，跨模块／renderer 订阅由 main 路由到对应 endpoint 或窗口／frame。`clipboard.changed` 仍是失效通知，消费者重新查询；不因引入 Gateway 变成可靠消息队列。

新增 Rust 业务模块时，只需用 `xw-gateway` 注册 handler／event，在自己的 napi 入口复用可选适配并返回 endpoint，再由 main 调用 `attachNative`；无需修改 Gateway 来识别新的业务名称。新增 TS 服务只需向 main host 注册 handler／event，不需要创建 Rust 包。后续 Storage 遵循同一方式，不是 Gateway 的特殊分支。

### 路由及执行约束

main 持有全局 owner／route／event 表，各 Rust 模块持有自己的 registry；Rust 本地命中直接执行，未命中才经异步 napi 回调请求 main 转发。main 向目标 owner 只执行本地 dispatch，不能再次 remote fallback，避免路由环。注册本地 handler 不等于已全局发布：main 校验并接受 manifest 后才能对外启用，失败须回滚。

普通 invoke 保留旧版默认 30 秒 handler 超时、每 route 32 并发、超额立即拒绝及 owner 生命周期；超时仅由执行 handler 的 owner 控制，转发层不叠加同一调用的执行超时。超时不保证数据库或系统副作用被撤销，不自动重试写操作。

旧版 payload 为 JSON，新的业务绑定使用 PB 字节，中转层在 napi 侧传 Buffer、Electron 侧传 Uint8Array，不转 Base64／数字数组，不提供任意 JS 对象传输。本地 typed 调用可保留直接调用路径，但不得改变契约／错误语义；旧 handler 适配与 protobuf 接口是本轮显式扩展，不宣称旧版已有此能力。

当前 renderer、main 和 Rust 自有业务全部可信，无逐 route 授权检查；未来不可信入口由宿主注入上下文并应用精确白名单（调用／开流和事件订阅分别授权），不能靠 payload 自报信任。该上下文在嵌套调用中保留，不能经一次可信模块转发后自动升级。窗口身份用于定向操作和生命周期管理，不等于给可信 renderer 增加 backend-only 限制。

本次不改变数据库所有权、数据目录、表结构、检索语义、图片／长文本存储或 UI；不处理既有剪贴板差异清单。当前不实现 WS／其他 socket、sidecar、Go 服务运行时或 RN 接入；三语言契约产物与远端连接实现是不同范围。Storage 的 DB／KV／Config 设计与验收由其独立 record 承载；本次不先发布占位的 `storage.*` 业务接口。

关键验收：接口同源生成且陈旧绑定被检查阻止；stream 有序、端到端背压、取消和终态无泄漏；Rust 本地调用不经 JS；两个独立 `.node` 经 main 双向调用与订阅；全局重名检查和原子注册；取消订阅／窗口重载／owner 注销无残留；默认可信、白名单不可伪造；图片字节无损；搜索 token 和窗口动作正确；剪贴板原有行为及数据不变。实际验证结果见 Outcome，已完成的 Plan 已删除。

## Outcome

### Plan 00：契约生成和测试

2026-09-19 完成 proto 测试 namespace、TS／Rust／Go 契约包、三语言消息和接口描述生成、产物入库与只读漂移检查。公开入口分别为 `xiaowei-contracts`、`xw-contracts`、`github.com/tctony-labs/xiaowei/contracts/go`；当前只有测试契约，没有生产业务、Gateway 绑定或运行时。长期工具与兼容说明维护在 [契约说明](../../../contracts/README.md)。

正式 protoc 固定为 36.2，与早期探针的 36.0 不同；生成脚本使用校验 SHA-256 后的官方包，缓存位于跨项目共享的 `~/.cache/protoc/36.2/`，不依赖系统 PATH。Protobuf-ES 2.15.0、prost／prost-build 0.14.4、Go plugin／runtime v1.36.6 分别固定。Go 插件按版本共享缓存于 `~/.cache/protoc-gen-go/v1.36.6/bin/protoc-gen-go`，首次安装后原子发布，每次使用前校验版本并通过绝对路径调用；后续生成／检查不再执行 go install，不覆盖全局插件。`contracts/generate.config.json` 分语言选择 proto 入口：TS／Rust 使用 `**/*.proto` 默认全量，Go 当前显式选中 `testing/fixture.proto`，后续按需加入服务端通信契约。通用测试使用独立的 `proto/testing/` 目录和 `testing` package，业务目录保留为 `proto/xiaowei/` 的约定，目前尚无业务 proto。Go 产物统一放在 `go/gen/`，项目内 import 映射从 go.mod 推导，测试 proto 不写死项目路径。生成器从 protoc 描述符递归补入项目内 import，各语言独立生成，空数组可关闭生成，漂移检查同时检测配置缩小后的多余产物。Rust 采用原生 FileDescriptorSet，不在本切片生成 Gateway adapter。当前没有真正共用的消息，因此未创建 common 占位类型。

验证证据：

- `pnpm install --frozen-lockfile` 与 `just check` 通过，包括生成漂移、TS 消费者类型、桌面既有类型、Rust 及 Go 检查。
- TS 测试执行器固定为 tsx 4.23.13，替换会调用已弃用 module.register() 的 4.20.6；在当前 Node 26 环境使用 `NODE_OPTIONS=--throw-deprecation pnpm contracts:test` 验证通过，未屏蔽弃用警告。
- `pnpm contracts:test` 通过：TS／Rust／Go 消费者、双向语言组合、Unicode、uint64 最大值及超过 JS 安全整数范围、optional、oneof 显式 null、嵌套 2 MiB bytes、非法 wire、字段编号／reserved、unary／streaming／event 描述一致。
- 新增未知字段字节在三端可解码；Protobuf-ES／Go 保留，prost typed 往返丢弃。后续 Gateway 中转必须保留原始字节。
- 测试 namespace 已与业务目录分离；迁移后 `just check` 与 codec 测试通过。临时 `portable_check` 业务目录验证了无 go_package 的跨目录消息引用及 well-known types，生成的 Go 包编译通过；清理临时 fixture 后原有产物字节一致。
- 分语言选择的三项自动测试通过；临时真实 proto 验证 Go 自动包含 import 依赖、排除没有 go_package 的本地契约。关闭 Go 后 check 只读报告旧产物，generate 清理 Go 产物，TS／Rust 保留；恢复配置与临时 fixture 后原有产物字节一致。
- Go 插件共享缓存首次安装及复用验证通过：缓存命中后将 PATH 中的 go 替换为必失败的测试入口，generate／check 仍通过；缓存文件 inode、mtime 和摘要及全部生成产物保持不变。
- 连续两次生成产物字节一致。分别修改及删除 TS、Rust descriptor、Go 产物，六种故障均使 check 失败且不改动故障现场；恢复后 check 通过。

本切片仅在 macOS arm64 验证，不宣称其他平台已经验收；未启动桌面实例，也未涉及现有 napi 包的代码或依赖。Plan 00 已经用户确认。Plan 00 的后续核心实现结果见下一节；整个 Gateway 事项仍在实施中。


### Plan 01：Gateway 核心逻辑与测试契约验证

2026-09-20 完成 `gateway/ts` 和 `gateway/rust` 两个环境无关包，显式纳入 workspace。实现 PB typed client／handler、manifest、routes／events 全批原子注册、新 owner 实例与旧句柄隔离、本地优先／单次远端回退、执行端超时与并发限制、显式事件导出、三种每订阅队列及可注入事件 transport。当前接口和运维约定已写入 [Gateway 核心](../../../gateway/README.md)，此处不重复维护。

已完整核对旧版 invoke.rs、event.rs、xw-gateway.md 和 xwIpc.ts，迁入原注册、typed payload、远端调用、并发、filter、Ordered burst、backend 订阅保留／清理和旧 epoch 隔离的测试语义，以 PB 和注入 sink／transport 替换 JSON、Tauri 与 socket 装配。保留默认 30 秒／32 并发、事件 best-effort／at-most-once；补全批内重复检查、跨 routes／events 原子性、owner 关闭 pending 失败，以及迟到订阅成功／失败不得影响新连接。Rust 的超时测试包含真实 spawn_blocking 任务，验证真实结束前不释放并发许可。

Rust 绑定使用 Plan 00 已提供的 FileDescriptorSet，在 Gateway 内生成 Method 常量并复用通用适配；没有把 Gateway 代码或业务接口写入 contracts，也没有重新生成消息类型。控制／契约版本当前均为 1，按 route 检查版本、方法种类和消息名；兼容字段增加不采用 descriptor 指纹拒绝策略。TS 默认编译入口及 protocol／host 子路径提供 runtime／types exports，浏览器侧入口不引用 Node／Electron。

验证证据：

- `pnpm install --frozen-lockfile`、`just check`、`just test` 通过，包括现有 Rust／Node 原生绑定／桌面脚本／Go 回归和 Plan 00 三语言 codec 测试。
- `cargo test -p xw-gateway --no-default-features --locked` 通过，包含绑定漂移检查及错误 handler 入参／返回值的 compile-fail；默认 normal 依赖链不含 napi／Tauri。
- TS 包 check／test／build 通过，包含错误入参／返回值和 stream 误用的编译反例；Node 直接导入编译后的包入口成功。
- 同一组 wire 样例覆盖两端有效／损坏 PB；测试 CLI 通过通用 adapter 完成 TS→Rust、Rust→TS，覆盖 uint64 上限、Unicode、optional／oneof、嵌套 2 MiB bytes、未知 route、handler 错误及 unary 误调 stream。
- 权限测试覆盖可信免白名单、精确白名单拒绝、伪造上下文无效及嵌套调用不提权。事件测试覆盖过滤、256 项 Ordered burst、Coalesce／Drop、晚注册／重注册、caller 清理、幂等 close 及旧连接迟到结果。

没有修改 UI、数据库、业务模块或现有 napi 包依赖，未启动或重启桌面；该核心当前没有产品消费者，所以本切片没有受影响的 napi 包需要重建。只验证 macOS arm64 的核心及 fake transport，不宣称已验证真实 Electron／TSFN 链路。Plan 01 已删除，Plan 02–04 保留；用户已确认本切片并要求继续 Plan 02。


### Plan 02：napi 传输适配与联调

2026-09-20 完成可选 `xw-gateway::napi` 适配、两个原生包的 endpoint 薄封装、TS `xiaowei-gateway/native` 接入及真实双 `.node` 测试。没有新增 gateway 原生包或 sidecar；两端 registry 按实例持有，不使用跨动态库共享 static。正式 endpoint 暂无业务 routes，现有搜索／剪贴板 API 继续工作。长期接入、控制编码、生成类型、测试构建及关闭约定见 [Gateway 核心](../../../gateway/README.md)。

技术验证确认 Rust future→TSFN→JS Promise→Rust 结果可用，保持 Buffer 字节并捕获 Promise reject 和同步 throw。全局名称先预留，绑定／激活完成后才发布；失败保留旧 owner 并关闭新 native 实例。调用上下文通过 host 维护的 token 沿嵌套请求传播，回退目标仍为来源时立即失败。事件支持 source 晚注册、重连和清理；正常关闭及环境销毁均释放 native 状态与回调。

联调中发现并修复两个实际线程边界问题：同步 JS 清理路径使用 napi 的运行时 spawn，而不是要求当前 Tokio 上下文的 spawn；异步导出方法先克隆 Arc，再通过 Env::spawn_future 返回 Promise，避免 Worker 销毁时跨线程释放 async &self 的 napi 借用保护。环境 cleanup hook 仅持 Weak 引用，同步关闭本地状态且不再调用 JS；显式 close 的 host 确认有 1 秒期限，失败返回控制错误。

新增测试 service `testing.PeerFixture`，与 Fixture 复用相同消息但拥有不同 route 名，以验证真正独立 owner 的双向调用。三语言契约产物和 Gateway 方法绑定由原工具重新生成；fixture 工厂与调用／发布／订阅探针全部由 `gateway-fixtures` feature 隔离。联调脚本构建到忽略目录，结束时恢复两个正常原生包；正常入口检查验证无 fixture 导出且 manifest 为空。

验证证据：

- `cargo test -p xw-gateway --no-default-features --locked` 通过；默认 normal 依赖链仍不包含 napi。
- `pnpm gateway:test-native` 的 10 项真实原生联调通过：本地不经 JS、A→main→B 和反向调用、重入／循环边界、3 MiB 全字节内容、Promise throw／reject、64 项 TSFN 队列满、timeout 后并发占用、pending 请求关闭、事件过滤／取消／重连及 256 项 Ordered burst、manifest 冲突／预留／回滚、权限传播、Node 自然退出和 Worker 强制销毁。
- 两个正常 `build:debug` 已生成最新 `.node`、JS 加载器和声明；生成的 endpoint 类型通过 TS 兼容检查，正式产物无测试工厂／方法。
- `just check`、`just test` 以及 Gateway TS build 通过；原搜索／剪贴板 napi 回归、桌面脚本、三语言契约 codec 和 Go 回归均通过。
- 通过绝对进程路径、cwd 和父子关系确认当前工作区开发实例后执行 `just rs`。Electron PID 从 17589 变为 92115，cwd 为当前 desktop；lsof 确认新进程已加载当前工作区两个最新 `.node`。没有冷启动或操作其他工作区实例。

未移动数据库、接入 UI 或迁移产品业务通信。Electron 进程重载验证不等于 Electron Gateway 全链路验收；Electron 接入仍按后续切片实施。仅在 macOS arm64 验证。Plan 02 已删除，用户确认后已提交为 `a874998`，响应流结果见下一节。


### Plan 03：可取消、有背压的响应流

2026-09-20 完成 TS／Rust typed 响应流、stream 专用绑定、owner／caller admission、open／next／cancel 状态机、native 二进制帧与真实跨模块联调。无通用双向 pipe、LLM provider、网络请求或 renderer 接线。默认 policy 与接口说明已回填 [Gateway 核心](../../../gateway/README.md#响应流)，不依赖临时 Plan。

Rust 生成器现在为 streaming 方法生成 `StreamMethod`，编译期区分 unary／stream；TS 提供独立的 bindStreamClient／bindStreamHandlers，unary binder 不再登记空的 stream 占位，两组注册可直接合并。客户端返回的流保留 typed chunk；中转只传原始 PB bytes 和序号，未修改业务消息契约。

open 前登记取消，native 同步准备请求后才派发异步任务；每流最多一个 next，cancel 不占用 next 的锁／队列。终态先同步确定，再清理 source、计时器和句柄。TS 非合作 producer 在退出前保留 admission，并对显式清理返回 1 秒 timeout；Rust owned source／future 被丢弃，独立生产任务需要遵循 channel 关闭。源会话 token 在晚到的嵌套取消时仍按原关联校验，已取消 open 的迟到结果也按实例校验，不会删除复用 ID 的新流。

默认单 chunk 1 MiB，主动队列 16 项／4 MiB，每 owner／caller 128／32 流，open 10 秒、生产／消费 idle 各 60 秒，总时长默认不限。PB 字节和生成对象预算分别检查；主动 send 必须等待，队列外只允许单个待发送和单个正在交付 chunk。native endpoint 有 128 句柄硬上限，Rust 远端握手另有 10 秒期限；远端成功握手返回 owner policy，后续 chunk／idle 使用其配置。Rust Drop 的远端 cancel 是独立的 best-effort 通知，本地取消确认不声称已经回滚远端副作用；这些边界均已写入长期说明。

验证证据：

- Rust `cargo test -p xw-gateway --no-default-features --locked` 通过，包含 6 项新增 stream 测试、绑定漂移及 3 项 compile-fail；本地 remote spy 为零，typed Drop、显式 cancel、caller 清理、pending open、admission 释放和有界队列通过。
- TS 核心共 20 项测试通过，包括 6 项 stream 测试：模拟 SSE 按需读取及 break 关闭、迟到 open 清理、pending next 取消／并发拒绝、队列字节／项数限额、owner 替换、caller 清理、不合作 producer 的配额保持，以及可控时钟的分阶段 timeout。
- `pnpm gateway:test-native` 共 14 项测试通过。新增流测试验证 TS→Rust、Rust 本地、A→main→B、空／多项／生产前及生产中错误、PB bytes、嵌套权限不提升、open／next 取消、跨 caller 拒绝、旧 owner／复用 ID 隔离、Worker 销毁。消费者停止后 B 的 poll 计数保持不变；取消后实际 producer 计数归零。
- 可控 Tokio 时钟验证远端 owner 允许的 70 秒生产等待与 2 MiB chunk 成功，不被 unary 30 秒或默认 stream producer idle 错杀。
- `just check`、`just test` 及 Gateway TS build 通过；最后状态机／policy 调整后重跑对应 Rust 核心、TS check／build 和真实 native 联调通过。两个正常 napi 包均已重新构建，正式声明不含 fixture 探针。

本切片仅在 macOS arm64 验证。正常构建后的当前工作区桌面实例已按归属检查后执行 `just rs`；Electron 从 PID 92115 变为 33412，lsof 确认加载当前工作区两个正常 `.node`；没有冷启动。产品尚未接入 Gateway stream，不能把原生测试或桌面模块重载描述为 renderer 全链路验收。Plan 03 已删除，保留 Plan 04；本切片已获用户确认并提交为 `c90959f`。


### Electron 与现有业务通信迁移

2026-09-20 实现 Electron main／preload／renderer 适配和生产业务契约。main 持有唯一 GatewayHost，搜索 endpoint 与原预热共享 SearchService，剪贴板 endpoint 使用既有 Service；未移动或重建用户数据库。业务 route 使用 PB full name，无独立手写 alias 表。初版曾保留 facade，后按用户要求删除（见下节）；搜索 token 和 UI 行为保持原语义；订阅 ready 先于初次列表快照，避免初始化竞态。启动失败回收已接入服务，退出关闭订阅、流和 native callback。

新增测试覆盖真实生产 endpoint 的临时数据库 CRUD／分类／收藏／文本及事件、Rust 图片字节、搜索空白／超长参数、frame 身份与权限、订阅 ready／提前取消／有界初始化、窗口导航／销毁和流取消。修正 typed stream 在首次 next 前取消不释放源的问题，并保留原搜索初始化日志。

验证证据（macOS arm64）：

- `just check`、`just test`、`pnpm gateway:test-native` 通过；后者包含 14 项原生传输／流测试及 2 项生产业务测试，正常两个 napi 包均已重建。
- 桌面生产 build、Storybook build 和未签名 `electron-builder --dir` 通过；ASAR 解包中恰有搜索、剪贴板两个 `.node`，Node 成功通过包内 JS loader 加载并关闭 endpoint。未启动打包后的应用，签名／其他平台不在本次验证范围。
- 确认现有 nodemon／Electron 的 cwd 和父子关系后，通过 `just rs` 临时启用本地 main debugger。在当前 Electron 内创建两个隐藏 sandbox／contextIsolation 测试窗口，验证普通 bridge 方法、Node 隔离、PB bytes／uint64、事件定向、native pull 无预取、pending next 取消、open 时导航和销毁释放 producer，全部通过。测试 finally 清理窗口和连接，不触碰业务存储。
- 现有产品窗口通过新 facade 成功查询计算器结果、剪贴板列表及分类；未执行真实系统动作或写用户数据。调试配置已恢复并重启为普通开发实例，9230 端口关闭，lsof 确认加载当前工作区两个正常原生模块。

用户试用后反馈整体未发现问题，本轮人工验收收尾，实施 Plan 已删除。产品未增加 LLM／Storage 能力，也没有引入第三个 `.node` 或 sidecar。


### 业务契约重划与直接 typed 调用

用户要求按能力重划 proto，不沿用旧 napi/IPC 和进程边界。已统一 app.proto / xiaowei.app / App，将主题切换和网页打开归入 System；ClipboardResources 删除，记录资源方法合回 Clipboard，并按完整方法名分属 Rust/main owner。Search 的动作使用 oneof／enum，开发模式由 endpoint 初始化配置注入；Launcher 的展示结果不包含动作或应用路径，保留结果批次校验和执行编排。系统状态、删除／更新结果、时间单位与预览截断都有明确字段。

前端旧 facade 和手写通信接口已删除，preload 只暴露通用 transport，renderer 使用按需缓存的 getClipboard/getLauncher/getApp/getSystem；Storybook 注入独立 GatewayHost。纯 UI 模型只处理字符串 ID、展示时间和预览，不包装业务方法。订阅 ready、迟到清理和布局保序迁入页面生命周期。

图标使用惰性 xiaowei-icon 资源 URL；构造搜索结果时不读取图标，实际图片请求由 main 协议处理器异步读取并缓存。Launcher.Icon 删除，不留兼容 route。真实 Electron 页面验证旧全局 API 为 undefined、typed 搜索与剪贴板查询正常，图标 URL 能加载为 1024×1024 图片。

创建与维护原则已落地 [业务 proto README](../../../contracts/proto/xiaowei/README.md)。自动测试覆盖业务具名结果、长文本摘要与全文、毫秒时间、未知 enum 拒绝、lazy getter 缓存、跨 owner 绑定和图标惰性读取；Storybook 的搜索选择与剪贴板切换已在现有 Electron 隔离窗口执行成功。用户已反馈整体未发现问题，按本轮验收通过收尾。


本次重划最终验证：`just check`、`just test`、`pnpm gateway:test-native`、桌面和 Storybook build、未签名打包通过。补充的生产原生测试验证取消收藏的 updated 含义、缺失记录、长文本预览／全文、毫秒时间和非法 enum。真实 Storybook `KeyboardAndComposition`、`OpenClipboard` 返回 success，后者使用延迟订阅初始化验证快照顺序。临时测试窗口与本地静态服务器已关闭，main debugger 启动配置恢复，当前工作区通过 `just rs` 回到正常开发实例；没有冷启动新应用。


### 完成与验收

用户在本轮功能验收后反馈整体未发现问题，按本轮人工验收通过记录；该反馈不是逐项测试报告，不扩大为所有平台、所有边界或签名发布均已验证。结合前述自动化、真实 Electron 和 Storybook 验证，Gateway 当前实施范围完成，Plan 04 及其空目录已删除。长期说明维护在 Gateway README、业务 proto README 和工作区文档；主 record 继续留在 active，成果仍生效。Storage 等独立后续事项不在本轮范围。


### 后续边界

当前 Plan 00–04 没有遗留实施步骤。以下能力不属于本轮交付承诺，按实际需求另行推进：

- 远端双向 WebSocket transport 与 Go Gateway runtime：目前只有设计约束，尚未实现服务端接入、认证和断线重连。
- 本地 socket transport 与独立 helper：待出现独立本地进程需求时实施。
- 不可信第三方插件的隔离宿主：现有调用权限机制不提供任意 Rust／JS 代码的沙箱。
- 跨平台与签名发布验证：当前证据覆盖 macOS arm64 开发环境及未签名打包，其他平台和签名发布仍需对应验证。

真实 LLM／SSE provider 与 Storage 属于后续业务接入，不是当前 Gateway 核心的缺失功能。


合并 develop 的应用图标缓存时，保留一周磁盘有效期与 Gateway 惰性资源 URL：协议处理器先查磁盘，缺失或过期再通过 App.ReadIcon 提取。已完成的读取不常驻 main 内存，避免绕过磁盘过期检查；缓存继续跨应用启动复用。

2026-09-20 调整桌面 Gateway 加载：package exports 增加 `source` 条件，类型入口直接指向源码；桌面 main/preload（含 SSR）、renderer、Storybook 与验收资源构建选择源码，移除 desktop check/build/dev:main 的 Gateway 预构建。普通 Node import 保留 dist，现有原生业务联调和 Electron 验收脚本仍可使用。无修改的 r 不再重写 renderer 共享依赖，真实源码修改仍触发 HMR；长期说明见 Gateway README。未采用内容比较后写入的构建包装器，保持独立 Node 场景原有 tsc 构建。`just check` 与 38 项桌面测试通过；实际 Vite 构建的模块清单确认三个目标均包含 Gateway src、没有 Gateway dist，默认 Node 解析仍指向 dist。
