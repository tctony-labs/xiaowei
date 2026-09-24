# Gateway

Gateway 提供环境无关的 TS host／client、Rust registry、Protobuf typed 绑定、响应流和事件，以及 napi／Electron 传输适配。业务消息由 [contracts](../contracts/README.md) 定义，具体 owner 由宿主装配。

## 工程入口

- [`ts/`](ts/)：npm 包 `xiaowei-gateway`。默认入口提供 client、协议和绑定，`/host` 提供宿主管理；两者不依赖 Node／Electron。`/native` 使用 Node Buffer，`/electron`、`/preload`、`/renderer` 分别提供 Electron 各侧接入。
- [`rust/`](rust/)：crate `xw-gateway`，默认纯 Rust；显式开启 `napi` feature 才编译原生适配。
- [`tests/`](tests/README.md)：跨语言、原生模块和 Electron 验收入口。

TS 类型入口指向源码，支持 `source` 条件的构建器可以直接消费源码；普通 Node 默认 import 指向 `dist/`，使用前需要构建。

## 接入约定

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

- [运行机制](../docs/gateway-runtime.md)：调用与错误、注册生命周期、响应流、事件、权限及 napi／Electron 协议。
- [桌面接入](../docs/gateway-integration.md)：业务 owner 装配、renderer service、资源读取及打包。
- [业务契约原则](../contracts/proto/xiaowei/README.md)：职责划分、消息语义和兼容性规则。
- [设计与实施记录](../.agent/records/active/2026-09-18-implement-gateway.md)：理由、取舍和验证结果。
