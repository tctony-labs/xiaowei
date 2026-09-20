# XiaoWei

XiaoWei 是一个开源个人效率工具，通过搜索和 AI Agent 帮助用户快速获取信息、处理任务。

## 一键运行

前置条件

- node：`>=26.3.1 <27`（`.node-version` 指定 26.3.1）
- pnpm：12.4.2（`packageManager` 指定版本）
- rust：1.98.1（`rust-toolchain.toml` 固定工具链版本）
- just: `cargo install just --locked`

```sh
just start
```

该命令会自动安装依赖、构建 Rust 原生模块和桌面代码，并启动 Vite 开发服务器与 Electron 应用。如果已有开发实例，会先停止旧实例，再启动当前工作区。

启动后可在终端按 `r` 重新构建并重启应用，按 `R` 重启整个开发环境，按 `Ctrl+C` 退出。

工具链版本、独立 Go 服务端启动方式及更多开发命令见 [工作区开发](docs/workspace.md)。
