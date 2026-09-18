# 引入统一 Gateway 与独立数据库服务

## Why

目前剪贴板由 `xiaowei-clipboard` 自行维护 SQLite，Electron 使用业务专用 IPC 接口。随着搜索、剪贴板和个人知识库之间的数据共享增多，需要统一模块调用方式，避免各模块分别持有数据库连接、重复维护状态，或要求调用方了解服务所在的模块／进程。

多个 `.node` 即使依赖同一个 Rust crate，也不会自动共享其中的全局变量、连接或内存实例；仅抽取公共存储 crate 不能解决统一数据所有权的问题。

## What

后续从 `xiaowei-next` 提取 gateway 机制，统一跨进程 IPC 和进程内 RPC。数据库作为独立服务模块，其他业务通过 gateway 访问它；renderer 也纳入同一 gateway。调用权限按可信／不可信划分，不按 renderer／backend 划分。

本事项当前只记录讨论形成的方向，不实施、不创建 Plan。以下均为拟议方案，不代表当前代码行为。

## How

### 统一服务调用

按全局服务名注册 handler，调用方使用 `route + payload`，不绑定具体实现位置。沿用旧版 `XwInvokeRegistry`、`XwEventRegistry`、`xwInvoke`、`xwOn` 的模型：本地命中时直接调用 handler，未命中时通过传输适配层路由到 owner。

进程内 RPC 与跨进程 IPC 共用寻址、协议和生命周期；本地调用不必绕行 Electron IPC 或 socket。保留服务名称冲突检查、按 owner 注册／注销、handler 超时与并发限制，以及显式事件导出和订阅清理。

Electron main 可作为当前多个 `.node` 模块之间的路由中心：原生模块注册服务，并通过适配层获得调用其他服务的能力。数据库服务实例只由一个 owner 持有，不因其他模块依赖同一 crate 而重复创建。具体 napi 回调和服务启动顺序在实施前细化，不要求合并现有原生包，也不因此引入新的子进程。

### 独立数据库模块

数据库模块统一维护 SQLite 连接、迁移执行、事务，以及后续 FTS5／tokenizer 接入。其他业务模块不自行打开数据库，通过 gateway 的数据库服务接口读写。

业务模块仍定义自己的表结构、迁移内容和业务 SQL，数据库模块提供参数化查询、执行和事务批处理机制，不承担“收藏”“备注”等业务规则。迁移注册顺序和版本管理需在实施前明确。

一次事务在数据库服务内部完整执行，不能将 `begin`、多次业务 RPC 和 `commit` 拆开，避免并发调用串入同一事务。需要根据前一条语句结果继续执行的事务，其参数引用或服务端执行方式需在接口设计时明确，不能退化为多个非原子的调用。

共享数据库不等于取消业务边界：业务校验与领域操作仍由对应业务服务负责；其他模块需要这些语义时调用业务 route。

### Renderer 接入与访问边界

```text
Renderer: xwInvoke("clipboard.search", { query })
    → preload → Electron IPC
    → gateway → 剪贴板业务 handler
    → gateway.call("database.query", { sql, params })
    → 数据库服务 → SQLite
```

以上 route 名和参数仅为示例，尚未确定最终接口。现有 `window.clipboardHistory` 等强类型业务封装可以保留，内部改用 gateway，组件不直接处理传输细节。

renderer 使用 `xwOn("clipboard.changed", handler)` 订阅事件。gateway 按实际窗口／frame 投递，在取消订阅、窗口销毁或重载时清理订阅。沿用旧版 best-effort、at-most-once 事件语义；可靠恢复通过重新读取快照或专门的历史接口实现。

调用方分为两类：

- 可信：不做 IPC 调用授权或白名单检查。当前调用方均为自有业务，包括 renderer、Electron main 和 Rust 模块，默认可信。
- 不可信：需要显式授权对应的 IPC 白名单，只允许调用已授权的 route；未授权的调用拒绝执行。

信任分类由宿主接入层确定，不通过业务 payload 自报。当前不为自有业务增加逐 route 授权配置；未来接入不可信调用方时显式标记并配置白名单。可信调用不做授权检查，不影响接口参数校验、业务校验、事务约束或订阅生命周期管理。

上图展示通过业务服务查询数据的常用链路，不是 renderer 的权限限制。可信 renderer 也可以调用 `database.*`，不设置 backend-only 限制；涉及领域规则时仍应使用业务服务，避免重复实现业务逻辑。

### 旧版参考与迁移边界

参考仓库：`~/Develop/XiaoWei/workspace/src/xiaowei-next`。

- `docs/xw-gateway.md`：服务寻址、本地优先、事件与 owner 生命周期。
- `crates/xw-tauri/src/invoke.rs`：调用 registry、typed adapter、超时和并发限制。
- `crates/xw-tauri/src/event.rs`：事件 registry。
- `xiaowei/src/api/xwIpc.ts`：前端调用和订阅封装。

提取与 Tauri 无关的机制，补 Electron／napi 适配及可信调用来源；不搬入旧版公司业务和私有依赖。host/studio socket、enrollment、多 peer 重连等机制待实际多进程需求出现后再评估，不把旧版完整部署结构作为本次前提。

## Alternatives considered

- 仅抽取 `xw-storage`，由各业务模块直接调用 Rust 接口：不能统一 renderer、独立 `.node` 与未来其他进程的调用方式，不作为本次方向。
- 先合并为单一 `.node` 以共享内存状态：并非引入 gateway 的必要条件，当前不要求这样调整。
- 按 renderer／backend 设置固定权限边界：不采用。当前自有业务默认可信，未来不可信调用方按 IPC 白名单授权。

## Current work

方向已记录，待后续明确启动实施。实施前需要细化服务实例与启动顺序、可信调用上下文、数据库迁移注册、事务批处理、错误协议及二进制数据传输；随后再制定具体迁移步骤。

后续验收至少覆盖：本地直调与跨边界调用使用相同契约；重复注册与 owner 注销；窗口订阅清理；自有业务默认可信且无需白名单，可信 renderer 可调用数据库 route；不可信调用方仅可调用已授权 IPC，不能通过 payload 提升信任级别；数据库事务失败回滚及并发隔离；现有搜索、剪贴板功能与数据升级不回归。
