---
name: maintain-gateway-contract
description: >-
  维护 XiaoWei 的 Protobuf 业务 service 与 Gateway 调用链。修改 contracts/proto/xiaowei/ 下的 service 或消息、调整 Rust 模块使用的 service、注册 handler 或增加 typed client 调用时使用；不用于 Gateway 核心传输实现本身。
---

# 维护 Gateway 业务契约

## 确定改动范围

读取 [业务契约原则](../../../contracts/proto/xiaowei/README.md)，核对相关 proto、调用方和实际 owner。用完整的 `package.Service.Method` 查找注册与消费位置；不要把生成配置中的 service 依赖当成运行时注册。桌面装配入口见 [main 装配与生命周期](../../../desktop/src/main/README.md#gateway-装配与生命周期)。

修改消息或 service 时检查字段编号、缺失值、默认值、错误语义及所有消费端。改变 package、service、方法或事件消息的全名会改变路由或事件名，须同步调用方和注册方。把具体语义写入 proto 字段／方法注释，不在 README 增加业务接口清单。

## 更新入口与生成绑定

- 新增 Rust package 时更新 `contracts/rust/src/lib.rs`；新增 TS proto 文件时更新 `contracts/ts/src/index.ts`。Go 仅在服务端需要时加入 `contracts/generate.config.json`。
- 在 [Rust 模块 service 配置](../../../gateway/rust/business_binding_config.rs)中，为每个调用或实现该 service 的 Rust 模块列出完整的 `package.Service`。该配置只选择 typed Method 常量，不创建 handler、endpoint、权限或 owner；TS 不使用这份配置。
- proto 或模块配置变化后，从仓库根目录执行 `just gen`：先生成契约与 descriptor，再生成各模块的 `src/gateway_binding.rs`。生成文件不得手改。只检查漂移时运行 `pnpm contracts:check` 和 `pnpm gateway:check`。

修改生成器或工具链时查阅 [契约生成机制](../../../contracts/README.md#文件选择与语言映射)，普通业务修改无需调整生成器。

## 接入调用与实现

- 手写业务 handler 模块的命名与边界遵循 [Gateway 接入约定](../../../gateway/README.md#接入约定)。
- Rust 模块引入自己的一份 `gateway_binding.rs`；unary 使用 `Method::handler`／`call`，响应流使用 `StreamMethod::handler`／`stream`。通过现有 endpoint 显式注册 owner。参考 [Storage 注册](../../../crates/xiaowei-storage/src/gateway.rs)和[剪贴板 DAO 调用](../../../crates/xiaowei-clipboard/src/dao.rs)。
- TS 使用生成的 service descriptor 和 `bindClient`／`bindHandlers`；流使用 `bindStreamClient`／`bindStreamHandlers`。同一 service 分属多个 owner 时，unary handler 使用 `{ partial: true }`，核对每条 route 只有一个 owner。renderer 调用沿用 [services.ts](../../../desktop/src/renderer/src/services.ts) 的入口。
- 事件须由 owner 显式导出并由消费者订阅，service 绑定不会自动发布事件。涉及事件或流时，按 [运行机制](../../../gateway/README.md) 检查 ready、取消、关闭及 owner 替换行为。
- 同步更新承载当前行为的 docs 或 active record。README 只更新职责、使用入口和稳定规则；实施取舍及验证结果写入 record，维护步骤留在本 skill，避免重复维护。

## 按改动范围验证

- 仅文档变更：检查路径、锚点和描述是否与源码一致。仅 proto 注释变更：运行生成及两项漂移检查，确认声明未改变。
- 消息、方法或调用链变更：运行 `just check`，并执行受影响模块的行为测试；编解码或生成规则变化时执行 `pnpm contracts:test`。覆盖本次变化涉及的参数边界、缺失值、错误结果及兼容性。
- Rust 原生 endpoint、跨模块调用或路由变化：业务变更执行 `pnpm --dir desktop test`；涉及 Gateway 通信实现时同时执行 `pnpm gateway:test`。核对模块配置、handler/client 和桌面装配指向同一完整路由。
- Rust 源码、napi 接口、依赖或构建配置变化（包括生成的 Rust 源码）：按根 [AGENTS.md](../../../AGENTS.md) 重建受影响的 napi 包。类型检查不能替代原生构建，已加载的 `.node` 不会自动更新。
- UI 视觉变化和桌面实例操作遵循根 `AGENTS.md`；本流程不授权冷启动桌面。

交付时说明实际执行的检查和仍待验证的行为，不把生成成功视为业务验证通过。
