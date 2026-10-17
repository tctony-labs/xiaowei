# xiaowei-rust

Electron 直接消费的常规 Rust 能力入口。npm 包为 `xiaowei-rust`，Cargo 绑定 crate 为 `xiaowei-rust-napi`，生成一个 `.node`，聚合 Storage、Clipboard、Search 和 Platform 的 napi 接入。业务实现仍分别属于 `xw-storage`、`xw-clipboard`、`xw-search`、`xw-platform`；Agent 由独立的 `xiaowei-agent` addon 提供。

## 准备与验证

在仓库根目录安装依赖后执行：

```sh
pnpm --filter './crates/*/napi' --workspace-concurrency=1 run build:debug
pnpm --filter xiaowei-rust test
pnpm gateway:test
pnpm --dir desktop test
```

绑定测试包含两个 addon 的日志接线，因此先构建常规包和 Agent 包。`build` 生成经过本地符号裁剪的 macOS release 产物，`build:debug` 保留调试符号；生成的 JS 加载器与声明不手改。

`napi/src/` 按 `search`、`clipboard`、`storage`、`platform` 划分绑定代码。共用 `GatewayEndpoint` 负责 napi 协议适配，按 endpoint 保留资源所有权和关闭顺序；各业务 owner、registry 和服务实例继续独立。单个 addon 共享一个日志 sink，不共享 Agent 的 sink。原生调用与跨业务通信约定见 [Rust 原生模块开发](../README.md) 和 [Gateway](../../docs/gateway.md)。

## 文档

- [剪贴板核心](../xw-clipboard/README.md)
- [搜索核心](../xw-search/README.md)
- [存储核心](../xw-storage/README.md)
- [平台绑定与资源所有权](docs/platform.md)
- [平台实现](../xw-platform/README.md)
- [桌面测试](../../desktop/tests/README.md)
- [打包与更新](../../desktop/docs/macos-release.md)
