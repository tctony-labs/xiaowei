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

## 桌面测试与验收工具

| 目录 | 边界 |
| --- | --- |
| [`desktop/tests/`](desktop/tests/README.md) | 自动回归门禁，以及运行器、初始化和 fixture；由 `pnpm --dir desktop test` 统一执行 |
| [`desktop/scripts/`](desktop/scripts/README.md) | 需要显式执行的手动验收工具，例如依赖模型配置和真实 API Key 的 LLM 验收；不纳入自动测试入口 |

按执行条件划分，不按“是否包含断言”划分：自动回归使用可控的本地服务、临时数据和测试凭据，不依赖个人环境或真实外部服务；需要真实凭据、应用实例或人工操作的验收放在 `desktop/scripts/`。手动工具自身的自动回归仍放在 `desktop/tests/`，通过本地 fixture 验证，不连接真实服务。

根目录 `scripts/` 承载工作区开发、构建和测试编排工具；桌面专用的手动验收工具归 `desktop/scripts/`。
