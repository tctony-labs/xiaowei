# 引入统一 Storage 模块

## Why

目前剪贴板由 `xiaowei-clipboard` 自行维护 SQLite。随着搜索、剪贴板和个人知识库共享数据，以及键值状态、配置需求增多，需要统一持久化能力，避免各业务重复持有连接、状态和配置读写逻辑。

多个 `.node` 即使依赖同一个 Rust crate，也不会自动共享其中的全局变量、连接或内存实例；仅抽取公共存储 crate 不能解决统一数据所有权的问题。

## What

引入 `xiaowei-storage`，在同一个应用模块内提供 DB、KV 和 Config 能力，通过 [Gateway](../active/2026-09-18-implement-gateway.md) 暴露服务。Gateway 是独立的核心通信机制，不包含 Storage 业务，也不依赖本模块。

本事项仍处于方案阶段，尚未实施、未创建 Plan。现有剪贴板存储保持当前行为；不能把 Gateway 通信接通视为存储已经统一。

## How

模块命名为 `xiaowei-storage`，合并 DB、KV 和 Config 三类应用持久化能力，内部按职责划分。按现有 Rust／napi 接入约定，计划放在 `crates/xiaowei-storage/`，npm 入口位于其 `napi/` 子目录；不为三类能力各建一个独立原生包。

| 能力 | 职责 | Gateway namespace |
| --- | --- | --- |
| DB | SQLite 连接、参数化查询和执行、事务、迁移执行，以及后续 FTS5／tokenizer 接入 | `storage.db.*` |
| KV | 按 namespace 管理键值读写、删除，供业务保存独立的小型状态 | `storage.kv.*` |
| Config | 配置读取、默认值、更新与变更通知；通过配置接口表达配置语义 | `storage.config.*` |

namespace 已确定，具体方法和请求／响应类型待 Storage 阶段设计。Config 可以复用 KV 保存持久值，但不能仅将 KV 接口改名：配置项定义、默认值和校验由对应业务提供，Storage 承载统一读写和通知机制。配置变更通知复用 Gateway 的事件能力，不另建通信机制。KV 的 namespace 是数据组织边界，不自动代表调用授权。

Storage 不反向成为业务集合：业务模块仍定义表结构、迁移内容、业务 SQL 及领域规则；Storage 负责执行和持久化，不承担“收藏”“备注”等业务。其他能力只有属于应用持久化职责时才考虑纳入，不扩展成泛用 `core`／`app` 杂项模块。DB、KV、Config 是否共用同一 SQLite 文件、KV 的具体后端及配置覆盖规则尚未确定，不能把“合并模块”理解为已经选定这些细节。

其他模块通过 Gateway 访问 Storage，由其统一持有连接和状态，不因多个 `.node` 依赖同一 crate 而重复创建。业务侧不再自行打开被 Storage 接管的数据库；现有剪贴板数据库所有权在 Storage 阶段才迁移。

一次数据库事务在 Storage 的 DB 能力内部完整执行，不能将 `begin`、多次业务 RPC 和 `commit` 拆开，避免并发调用串入同一事务。需要根据前一条语句结果继续执行的事务，其参数引用或服务端执行方式需在接口设计时明确，不能退化为多个非原子的调用。迁移注册顺序和版本管理同样在实施前明确。

共享存储不等于取消业务边界：业务校验与领域操作仍由对应业务服务负责；其他模块需要这些语义时调用业务 route。可信调用方可以直接调用 Storage，不增加 backend-only 限制。

### 调用与权限

```text
Renderer / main / Rust 业务模块
    → gateway.call("storage.db.query", { sql, params })
    → xiaowei-storage 的 DB 能力 → SQLite
```

具体方法名与参数仅为示例。当前所有自有业务默认可信，包括 renderer，可直接调用 `storage.db.*`、`storage.kv.*` 和 `storage.config.*`，不设置 backend-only 限制。未来不可信调用方遵循 Gateway 的显式白名单授权，Storage 不另建一套信任机制。可信调用不免除参数、配置和事务校验；涉及领域规则时应调用对应业务服务。

目录由 main 的 `paths.ts` 统一定义并传入，Storage 管理业务目录内的文件路径，不自行推导平台应用目录。实际目录布局及现有数据迁移策略在实施前明确。

## Alternatives considered

- 仅抽取 `xw-storage` 公共 crate，各业务自行打开数据库：无法确保独立 `.node` 之间共享实例和数据所有权，不采用。
- DB、KV、Config 分为三个独立应用模块：当前统一纳入 `xiaowei-storage`，内部按能力划分，不为它们分别建立原生包。
- 命名为 `core` 或 `app`：职责过宽，不采用；Storage 限定应用持久化能力。

## Current work

已确定模块名称、DB／KV／Config 范围及 Gateway 接入方向；等待通信基础完成后单独制定实施计划。实施前需明确：

- 服务实例与启动顺序；DB、KV、Config 是否共用文件和连接，以及目录布局。
- 数据库访问库、业务迁移注册／排序／版本、现有剪贴板数据与连接所有权迁移。
- 参数化查询、BLOB 和错误协议；原子事务及依赖前条执行结果的事务表达。
- KV namespace、键和值类型，以及 Config 默认值、校验、覆盖和持久化后的变更通知规则。
- FTS5／tokenizer 的接入范围和公开依赖可用性，不擅自替换旧版技术方案。

后续验收覆盖：跨模块访问同一份数据、事务失败回滚与并发隔离、迁移失败处理、KV namespace 区分和跨重启持久化、配置默认值／校验／更新通知、可信 renderer 直接调用，以及剪贴板既有数据和业务行为不回归。
