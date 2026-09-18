# 01：Gateway 核心逻辑与测试契约验证

主事项：[实现核心 Gateway 通信机制](../../records/active/2026-09-18-implement-gateway.md)。依赖已定稿的 Plan 00；本计划范围已由用户确认定稿，尚未实施。

## 范围与前置条件

实现 TS／Rust Gateway 核心逻辑及通用 client／handler 绑定机制，复用 Plan 00 的测试契约验收，不迁移真实业务；不接 Electron、不改数据库或业务、不改 UI。真实业务契约与对应 handler 接入在 Plan 04 实现，本切片不定义搜索或剪贴板业务接口。先完整核对旧项目 `crates/xw-tauri/src/invoke.rs`、`event.rs`、`docs/xw-gateway.md` 和 `xiaowei/src/api/xwIpc.ts`。保留旧测试及语义；剥离 Tauri AppHandle、角色 Service 和 socket broker 依赖，不能用另一套通信框架替换。

## 文件与职责

| 文件／目录 | 修改内容 |
| --- | --- |
| `gateway/rust/Cargo.toml`、`src/lib.rs` | 默认只编译纯 Rust 核心，沿用 serde、tokio 等公开依赖；napi 可选适配由 Plan 02 添加 |
| `gateway/rust/src/invoke.rs` | owner 注册／替换／注销、typed handler、本地调用与远端回退 |
| `gateway/rust/src/event.rs` | 显式事件导出、filter、订阅句柄、队列及 owner 清理 |
| `gateway/rust/src/protocol.rs` | 值类型、错误、注册清单、宿主调用上下文 |
| `gateway/ts/package.json`、`tsconfig.json`、`src/` | `src/core/` 实现 protocol、registry、client；默认入口提供环境无关绑定和 transport 接口，宿主使用核心创建唯一 host，不引用 Electron |
| `gateway/ts/src/binding/` 与 `gateway/rust/src/binding.rs`（必要的生成适配放对应工具目录） | 消费 contracts 的类型／描述，实现 typed client、handler 注册和 PB 编解码适配；不重新生成消息类型 |
| 两个包的单测目录与 `gateway/tests/` | 核心单测、共享契约样例与跨语言边界验证 |
| 根 `Cargo.toml`、`Cargo.lock`、`pnpm-lock.yaml` | 核对 workspace 纳入及公开依赖；显式加入 `gateway/rust` 与 `gateway/ts`，不依赖原有 `crates/*`、`packages/*` 通配范围 |

TS 包提供 `check`、`test`、`build` 和明确的 runtime／types exports，不能只靠开发环境解析源码。renderer 可导入的 client／protocol 入口不得传递依赖 Node 内置模块。

全局 route／owner 表由 TS main 的唯一 host 持有；每个 Rust 模块的 registry 持有本地 handler 和实际执行状态。转发侧不重复维护执行并发计数。普通业务包由宿主注入 client；`main`／`preload`／`renderer` 的 Electron 接入入口在 Plan 04 实现。Go Gateway 仅记录为后续方向，本切片不创建实现或占位包。

## 执行步骤

1. 提取旧 Rust invoke registry，以注入 transport／事件 sink 替代 Tauri 依赖。先跑迁入的旧测试，再补 adapter 测试。
2. 明确 `invoke(route, payload)`、`dispatchLocal`、`registerOwner`、`unregisterOwner`、`subscribe`、`publish` 的边界。全局名称唯一；同 owner 替换先完整验证再提交，批内重复和跨 owner 重名均不得留下半注册状态。
3. 消费 Plan 00 的语言契约包与 service descriptor，在本切片实现通用 typed client／handler 注册 adapter 和 Gateway manifest：调用方编码请求、交给 registry、解码结果；服务方解码请求、调用 handler、编码结果。类型从契约推导，错误参数／返回值在编译中可发现；领域校验仍由 handler 负责。明确 route 名与 event 名的映射，绑定或必要的生成适配归 Gateway，通用消息生成仍归 contracts。按 route 检查控制协议版本、契约兼容规则和方法种类，不允许以 invoke 误调 stream；stream 暂只识别声明，执行与取消在 Plan 03 实现。TS main 维护全局 owner 清单与 dispatcher。owner 标识由宿主分配，每次接入拥有新的实例标识；旧连接注销、旧返回值不能作用于新实例。本地 TS handler 直接调用；Rust owner 通过适配接口 dispatch，不绕 Electron IPC。
4. 业务 wire payload 使用 PB 字节；空请求使用定义的空 message，不能把 null 当成通用消息。64 位整数使用生成的 bigint／u64，现有字符串 ID facade 显式适配。中转层不 decode／encode 业务消息。响应为成功值或 `{ code, message }` 错误；至少区分未知 route、owner 不可用、参数错误、并发已满、执行超时、未授权和 handler 错误。适配器不得依赖 Electron 对 Error 自定义字段的序列化。
5. 普通 invoke 注册元数据保留旧版 timeout 和 maxConcurrency 默认值（30s、32），在执行 owner 实施，超额立即拒绝，不引入无界等待队列；stream 的执行周期由 Plan 03 单独定义。超时不表示副作用回滚；若底层阻塞任务仍在执行，其资源占用需跟踪至真实结束，不能超时后无限启动新的任务。
6. 迁移显式事件导出、filter 验证／匹配、Ordered／Coalesce／Drop 策略；保留每订阅语义及 best-effort、at-most-once，不承诺跨来源全序或历史补发。旧版 Ordered 队列不按任意固定容量静默截断；不要在迁移中自行改成另一种投递语义。
7. 可信上下文直接执行，不配置 route 白名单；不可信上下文按精确调用／订阅白名单检查。上下文只能由宿主构造，所有转发和本地调用走同样规则；业务参数验证保留。renderer 不能注册 owner、任意发布事件或指定 caller 元数据。
8. 日志仅记录 route、owner、耗时和错误码，不默认记录剪贴板内容、SQL 参数或二进制数据。

## 验证与完成标准

- 使用 Plan 00 的测试契约，通过通用调用／注册绑定在 fake transport 上运行测试服务；验证 TS／Rust 错误入参和返回值的编译反例，不向产品注册测试 route。
- 绑定与同一套契约用例覆盖 TS／Rust：有效／无效 PB、optional／oneof、64 位整数与字符串 ID 适配、嵌套 bytes、未知 route、handler 抛错。
- 本地 handler 命中时，注入的 remote spy 调用次数为零；未命中恰好转发一次；目标不存在立即返回未知 route，无回退环。
- 全批注册原子性、重复名称、同 owner 替换、注销后的新请求失败、旧实例迟到响应处理。
- handler 超时、并发上限、未结束阻塞任务占用，以及 owner 关闭后 pending 请求获得明确失败；不承诺强制中断已发生的系统副作用。
- 显式事件导出、filter、Ordered burst、Coalesce 最后状态、Drop 策略、幂等 unsubscribe；owner 晚注册／重注册的订阅恢复按旧版保留，不能无限缓存事件。
- 自有业务无白名单可用；不可信未授权调用和订阅拒绝，payload 伪造 trusted 无效，嵌套调用不能提升权限。
- `cargo test -p xw-gateway --no-default-features`、TS 包 check／test／build 通过；确认默认依赖链不引入 napi。回填主 record 的已实现协议与证据，再删除本 Plan。
