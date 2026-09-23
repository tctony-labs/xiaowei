---
name: maintain-gateway-contract
description: >-
  维护 XiaoWei 的 Protobuf 业务 service 与 Gateway 调用链。修改 contracts/proto/xiaowei/ 下的 service 或消息、调整 Rust 模块使用的 service、注册 handler 或增加 typed client 调用时使用；不用于 Gateway 核心传输实现本身。
---

# 维护 Gateway 业务契约

## 确定契约与使用方

先读取 [业务契约原则](../../../contracts/proto/xiaowei/README.md)，核对相关 proto、现有调用方与实际 owner。proto `package` 决定消息全名和 `package.Service.Method` 路由，表示业务命名空间，不按实现 crate 划分；例如 `ClipboardDao` 属于 `xiaowei.clipboard`，由 Storage 实现。一个 package 可以包含多个 proto 文件。调用方、实现方及方法拆分以当前代码为准，不把配置中的 service 依赖误当成运行时注册。

修改消息或 service 时同步检查字段编号、默认值、错误语义、事件名称和所有消费端。改变 package、service、方法或事件消息的全名会改变路由或事件名，须同时更新调用方、注册方和验证。新增 package 时维护 `contracts/rust/src/lib.rs`；新增 TS proto 文件时维护 `contracts/ts/src/index.ts`。Go 只在服务端确实需要时加入 `contracts/generate.config.json`。

## 声明模块依赖并生成

在 [Rust 模块 service 配置](../../../gateway/rust/business_binding_config.rs)中，为每个**调用或实现**该 service 的 Rust 模块列出完整的 `package.Service` 名称。配置只选择要生成的 typed Method 常量；它不创建 handler、endpoint、权限或 owner。TS 侧不使用此配置，也不生成单独的模块绑定文件。

从仓库根目录执行 `just gen`：先运行 `pnpm contracts:generate`，按 proto 文件生成 TS 描述，按 package 生成 Rust 消息并更新 `descriptor.bin`；随后运行 `pnpm gateway:generate`，根据模块配置为每个 Rust 模块生成固定的 `src/gateway_binding.rs`。生成文件均不得手改。若只检查漂移，执行 `just check`；其中的 `contracts:check` 和 `gateway:check` 不改写源码。

## 接入调用与实现

- Rust 模块只引入自己的一份 `gateway_binding.rs`。实现端用对应的 `Method::handler` 注册方法；调用端用 `Method::call` 发起 typed 调用。参照 [Storage 的 KV 注册](../../../crates/xiaowei-storage/src/gateway.rs)和[剪贴板的 DAO 调用](../../../crates/xiaowei-clipboard/src/dao.rs)。通过现有 Gateway endpoint 显式注册 owner；生成配置不会自动注册。
- TS 直接使用契约 `*_pb.ts` 导出的 service descriptor，通过 `bindClient` 或 `bindHandlers` 建立 typed 调用或注册。参照 [renderer service 入口](../../../desktop/src/renderer/src/services.ts)。同一 service 的方法由多个 owner 实现时，handler 使用 `{ partial: true }`，并确保每条路由只有一个 owner。
- 事件使用消息的 protobuf full name，仍须由 owner 显式导出和由消费者订阅；生成 service 绑定不会自动发布事件。具体机制见 [Gateway](../../../gateway/README.md#事件)。

## 验证

运行 `just check` 和与改动相关的 `just test`。涉及 Rust 原生 endpoint、跨模块调用或路由变更时，执行 `pnpm gateway:test-native`；Rust 源码改动还须按根 `AGENTS.md` 重建受影响的 napi 包。核对生成文件、模块配置、Rust handler/client、TS descriptor 使用方及桌面装配均指向同一完整路由。若修改了实际 UI，另遵循根 `AGENTS.md` 的 Storybook 确认流程。
