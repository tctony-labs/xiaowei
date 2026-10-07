# 实现核心 Gateway 通信机制

## Why

目前 Electron 使用业务专用 IPC 接口，renderer、main 和独立 Rust 原生模块之间缺少统一寻址和调用方式。随着模块间调用增多，需要一个独立的核心通信机制，使调用方不必了解服务所在的模块／进程。

多个 `.node` 即使依赖同一个 Rust crate，也不会自动共享 registry 或内存实例，需要显式的本地注册和跨模块路由。

## What

从 `xiaowei-next` 提取 gateway，作为独立的核心通信机制，统一跨进程 IPC 和进程内 RPC，覆盖 renderer、main 和 Rust 模块。Gateway 不依赖具体应用模块，也不包含数据库、配置或其他业务逻辑。调用权限按可信／不可信划分，不按 renderer／backend 划分。

应用模块通过 Gateway 暴露能力；搜索、剪贴板及 [Storage](../../../docs/storage.md) 都是调用方／服务提供方。Gateway 不依赖 Storage，也不是它的专用桥接层。

本事项已实现三语言契约工程、核心／绑定、napi 适配、响应流及 Electron 业务通信迁移。搜索、剪贴板和窗口操作已经通过 Gateway 接入，直接使用生成的 typed client 并保留既有 UI 行为。自动化及真实 Electron 边界验证已通过；用户完成本轮试用后反馈整体未发现问题，本轮人工验收收尾。Storage 保持独立事项。当前契约见 [契约说明](../../../contracts/README.md)，运行时见 [Gateway 架构](../../../docs/gateway.md)，包与 Electron 接入见 [Gateway](../../../gateway/README.md)。

## How

当前架构、注册与请求生命周期、流、事件、权限及线协议已提取到 [Gateway 架构与运行机制](../../../docs/gateway.md)。语言侧 API 保留在 [TS](../../../gateway/ts/README.md) 和 [Rust](../../../gateway/rust/README.md)，接入入口在 [Gateway README](../../../gateway/README.md)，验收方式在 [测试说明](../../../gateway/tests/README.md)。后续更新这些长期说明，不向本记录追加当前行为。

本轮关键取舍：

- 保留旧版本地优先、owner 生命周期与事件模型，使用 Protobuf 同源消息和 typed 绑定替代 JSON DSL；不引入完整 gRPC 运行时或 Mojo。Contracts 独立于业务、Gateway 与传输，Gateway 仅补绑定，不重写消息生成器。
- 每个 Rust addon 持有自己的 registry／业务实例，main 只持有一个全局 host；通过异步 napi 显式路由，不依赖动态库共享 static，也不为此合并 `.node` 或创建 sidecar。
- 流采用 pull、独立取消和有界主动队列，执行许可保留至实际执行结束；不承诺回滚外部副作用、自动写重试或重连续传。
- 自有 TS／Rust／renderer／worker 代码默认可信，宿主创建并沿嵌套调用传播上下文；不按进程位置重复划分业务授权，句柄归属与生命周期检查仍保留。
- WebSocket、Go Gateway runtime、本地 socket 和不可信插件隔离宿主不属于本轮实现范围。远端认证、显式导出、路由作用域和连接实例隔离约束提取到 [后续远端设计](../../../docs/gateway.md#远端服务与双向-websocket尚未实现)。业务选择 HTTP／WebSocket 的后继方向见 [xwapi](../../../docs/xwapi.md#后续-http-与-websocket-选择尚未实现)。

旧版参考仓库为 `~/Develop/XiaoWei/workspace/src/xiaowei-next`，核对范围及扩展差异由下方实施结果记录；旧版 socket／enrollment 部署结构未搬入本轮实现。

## Alternatives considered

- 先合并为单一 `.node` 以共享内存状态：并非引入 gateway 的必要条件，当前不要求这样调整。
- 按 renderer／backend 设置固定权限边界：不采用。当前自有业务默认可信，未来不可信调用方按 IPC 白名单授权。

## Outcome

2026-10-07 用户明确要求归档。原实施范围与本轮必要验收已完成，无遗留 Plan；共同运行说明和尚未实现的远端／socket 设计迁入 [Gateway 长期文档](../../../docs/gateway.md)。归档结束该次建设，不表示 Gateway 弃用；后续重大开发另建事项，常规修复维护代码及长期说明。历史测试命令、包入口、生成范围和阶段性状态只反映当时证据，不作为现行使用说明。

Protobuf 前期探针验证 TS／Rust typed unary、uint64、optional／oneof、2 MiB bytes、事件及惰性流，证明无需 gRPC 运行时即可绑定自定义 transport；探针位于忽略目录，不是产品依赖。真实 TSFN、Electron 和三语言生成的交付验证以下方结果为准。

2026-09-25 将 TS ↔ Rust napi 适配入口统一改名为 `rust-napi.ts`、`xiaowei-gateway/rust-napi`、`attachRustNapi` 和 `RustNapiEndpoint`，同步调用方、测试与说明，不保留旧导出。`pnpm gateway:test`、`pnpm --dir desktop test`、`pnpm --filter xiaowei-clipboard test`（3 项）及 `just check` 均通过；未执行 Electron 运行验收。

2026-09-24 测试归属与入口整理：统一 `gateway:test` 覆盖 Rust／TS 核心、worker 构建产物与 TS ↔ Rust napi 通信；Storage、剪贴板业务、LLM、System 和启动生命周期迁至 desktop，由单一 `test` 内部编排。删除按测试实现细分的 package scripts，原 `native` 测试目录改为 `rust-napi`，只 mock 宿主的装配测试归 `main`；根构建入口改为 `build:rust`。迁移保留原测试及断言，未改变产品 API。

验证通过统一 Gateway 入口（28 项 Rust 测试、3 项文档反例、48 项 TS、1 项构建后 Node、15 项 Rust napi 通信）、统一 desktop 入口（26 项模块、5 项装配、3 项 LLM、64 项组件、10 项 Rust 业务联调）、2 项 fixture 构建／测试失败恢复回归及 `just check`。共享构建／恢复逻辑保留各阶段失败并始终尝试恢复全部 addon，正式 Rust 产物已恢复并检查。迁入 TS 测试纳入 desktop 类型检查；根 workspace 测试串行编排，避免两个入口争用相同 Rust 产物。未启动 Electron，未执行 e2e。

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

2026-09-20 完成 `gateway/ts` 和 `gateway/rust` 两个环境无关包，显式纳入 workspace。实现 PB typed client／handler、manifest、routes／events 全批原子注册、新 owner 实例与旧句柄隔离、本地优先／单次远端回退、执行端超时与并发限制、显式事件导出、三种每订阅队列及可注入事件 transport。当前接口和运维约定已写入 [Gateway 核心](../../../docs/gateway.md)，此处不重复维护。

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

2026-09-20 完成可选 `xw-gateway::napi` 适配、两个原生包的 endpoint 薄封装、TS `xiaowei-gateway/rust-napi` 接入及真实双 `.node` 测试。没有新增 gateway 原生包或 sidecar；两端 registry 按实例持有，不使用跨动态库共享 static。正式 endpoint 暂无业务 routes，现有搜索／剪贴板 API 继续工作。长期接入、控制编码、生成类型、测试构建及关闭约定见 [Gateway 核心](../../../docs/gateway.md)。

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

2026-09-20 完成 TS／Rust typed 响应流、stream 专用绑定、owner／caller admission、open／next／cancel 状态机、native 二进制帧与真实跨模块联调。无通用双向 pipe、LLM provider、网络请求或 renderer 接线。默认 policy 与接口说明已回填 [Gateway 核心](../../../docs/gateway.md#响应流)，不依赖临时 Plan。

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

用户在本轮功能验收后反馈整体未发现问题，按本轮人工验收通过记录；该反馈不是逐项测试报告，不扩大为所有平台、所有边界或签名发布均已验证。结合前述自动化、真实 Electron 和 Storybook 验证，Gateway 当前实施范围完成，Plan 04 及其空目录已删除。本轮验收时 record 保留在 active；2026-10-07 按用户要求提取长期说明并归档，Gateway 成果仍在使用。Storage 等独立后续事项不在本轮范围。


### 后续边界

当前 Plan 00–04 没有遗留实施步骤。以下能力不属于本轮交付承诺，按实际需求另行推进：

- 远端双向 WebSocket transport 与 Go Gateway runtime：目前只有设计约束，尚未实现服务端接入、认证和断线重连。
- 本地 socket transport 与独立 helper：待出现独立本地进程需求时实施。
- 不可信第三方插件的隔离宿主：现有调用权限机制不提供任意 Rust／JS 代码的沙箱。
- 跨平台与签名发布验证：当前证据覆盖 macOS arm64 开发环境及未签名打包，其他平台和签名发布仍需对应验证。

真实 LLM／SSE provider 与 Storage 属于后续业务接入，不是当前 Gateway 核心的缺失功能。


合并 develop 的应用图标缓存时，保留一周磁盘有效期与 Gateway 惰性资源 URL：协议处理器先查磁盘，缺失或过期再通过 App.ReadIcon 提取。已完成的读取不常驻 main 内存，避免绕过磁盘过期检查；缓存继续跨应用启动复用。

2026-09-20 调整桌面 Gateway 加载：package exports 增加 `source` 条件，类型入口直接指向源码；桌面 main/preload（含 SSR）、renderer、Storybook 与验收资源构建选择源码，移除 desktop check/build/dev:main 的 Gateway 预构建。普通 Node import 保留 dist 供本包构建产物验收；后续工作区源码消费治理已将原生业务联调改为显式 source 条件，Electron 验收 main 也内联源码。无修改的 r 不再重写 renderer 共享依赖，真实源码修改仍触发 HMR；长期说明见 Gateway README。未采用内容比较后写入的构建包装器，保持独立 Node 场景原有 tsc 构建。`just check` 与 38 项桌面测试通过；实际 Vite 构建的模块清单确认三个目标均包含 Gateway src、没有 Gateway dist，默认 Node 解析仍指向 dist。

Electron 集成验收目录迁至 gateway/tests/electron，依赖由 gateway/tests/package.json 私有 workspace 包声明；测试资产构建通过，实际 Electron 验收仍显式在已有实例执行。桌面 source 条件解析测试改名并保留于 scripts/dev/desktop-source-resolution.test.mjs，迁移后通过。

2026-09-24 整理契约、Gateway 与维护技能的文档职责：README 保留工程入口和稳定规则，具体接口语义留在 proto，运行机制、桌面装配与生成器说明提取到 docs，测试步骤集中到测试目录 README，skill 按改动范围选择生成和验证步骤。本次只调整文档组织，不改变运行行为。


### Renderer client 重建后的句柄隔离

2026-09-25 修复热更新重建 renderer client 时订阅／流 ID 从头计数、与同一 preload 会话旧句柄冲突的问题。每个 client 使用随机 UUID 前缀隔离句柄，保留现有会话、ready 和清理语义；当前行为见 [TS Electron 接入](../../../gateway/ts/README.md#electron-接入)。

新增两项同会话 client 重建回归，修改前分别复现 `invalid subscription` 和 `invalid stream`，修改后验证新旧订阅投递、失败清理、旧订阅关闭及流取消互不干扰。原跨 frame 测试改用实际生成的句柄 ID。Gateway TS 31 项测试、check、build、改动源码 Biome 检查及 diff 空白检查通过。修改仅在主工作区完成，未启动或重启桌面；真实窗口热更新体验待用户启动主工作区实例后验证。

### 2026-09-26：Node 事件投递调度

Electron 原生快捷键可能在缺少微任务检查点的入口调用 JS，使原先 queueMicrotask 排队的通知等待无关任务。修复归入 Gateway 的 DeliveryQueue，Node 以 setImmediate 启动投递；浏览器仍使用微任务，不向共享入口引入 Node 模块。撤销快捷键业务回调包装，适用于所有经此队列投递的通知。实现约定见 [TS 事件与上下文](../../../gateway/ts/README.md#事件与上下文)，源码依据与真实热键验证边界见 [快捷键事项](../active/2026-09-18-fixed-launcher-shortcuts.md#原生快捷键与微任务调度)。

回归先阻断 queueMicrotask 证明旧实现无法送达，再验证本地／远端投递、取消订阅与浏览器回退；多级投递测试改为等待实际 sink 收到消息，不依赖固定事件循环轮数。

验证：`pnpm gateway:test` 全部通过（31 项 Rust 测试、52 项 TS 测试、1 项构建后 Node worker 测试、15 项真实 napi 联调），原生 fixture 已恢复为生产构建；Gateway／desktop 类型检查、Biome、12 项快捷键测试和 10 项 Launcher／QuickChatPanel 组件测试通过。用户随后通过实际 macOS 热键切换确认卡顿已修复；此结果对应 Gateway 统一调度、无快捷键包装和无调试日志的版本。
