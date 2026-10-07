# Gateway

Gateway 提供环境无关的 TS host／client、Rust registry、Protobuf typed 绑定、响应流和事件，以及 TS ↔ Rust napi、Worker MessagePort 和 Electron IPC 通信适配层。业务消息由 [contracts](../contracts/README.md) 定义，具体 owner 由宿主装配。

## 工程入口

- [`ts/`](ts/README.md)：npm 包 `xiaowei-gateway`。默认入口提供 client、协议和绑定，`/host` 提供宿主管理；两者不依赖 Node／Electron。`/rust-napi` 提供使用 Node Buffer 的 Rust napi 接入，`/worker-host` 与 `/worker` 提供 Node worker 两侧接入，`/electron`、`/preload`、`/renderer` 分别提供 Electron 各侧接入。
- [`rust/`](rust/README.md)：crate `xw-gateway`，默认纯 Rust；显式开启 `napi` feature 才编译 napi 通信适配层。
- [`tests/`](tests/README.md)：跨语言、原生模块和 Electron 验收入口。

TS 类型入口指向源码，工作区消费者必须通过 `source` 条件加载源码，Node 同时配置 TS loader。默认 import 的 `dist/` 入口保留给本包构建产物验收。

## 接入约定

- 为 Gateway 提供 handler 实现及相关接入代码的模块统一命名为 `gateway`：TS 使用 `gateway.ts` 或 `gateway/`，Rust 使用 `gateway.rs` 或 `gateway/`，放在所属业务模块内。具体业务逻辑按能力归属组织，由 `gateway` 调用；仅使用 Gateway client 的模块不因此归入 `gateway`。该命名约定针对手写业务接入代码，不改变生成绑定的文件名。
- 使用契约 descriptor 和 typed client／handler；route 为 `package.Service.Method`，event 为消息的 Protobuf full name。
- owner 显式注册方法与事件；同一 service 可拆分到多个 owner，但每条 route 只能由一个 owner 发布。
- 两端 handler 使用 `(request, client)`，按需从 client 获取上下文与取消信号；unary 返回可 await、可 cancel 的 RPC 句柄。
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

- 语言侧 API 与实现约定：[TypeScript](ts/README.md)、[Rust](rust/README.md)。共同语义与线协议见 [Gateway 架构与运行机制](../docs/gateway.md)。
- 桌面接入：[main 装配](../desktop/src/main/README.md#gateway-装配与生命周期)、[renderer 调用](../desktop/src/renderer/README.md#gateway-业务调用)；构建与打包配置见 [electron-vite](../desktop/electron.vite.config.ts) 和 [electron-builder](../desktop/electron-builder.json)。
- [业务契约原则](../contracts/proto/xiaowei/README.md)：职责划分、消息语义和兼容性规则。
- [设计与实施记录](../.agent/records/archived/2026-09-18-implement-gateway.md)：理由、取舍和验证结果。
