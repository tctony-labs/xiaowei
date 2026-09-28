# 工作区概要

XiaoWei 的工作区包含 Electron 桌面应用、Rust 原生模块和独立 Go 服务端。桌面使用 TypeScript、React 和 Tailwind CSS，通过 napi 接入 Rust 能力，通过 Gateway 连接各业务模块。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `desktop/` | 桌面应用；[main](../desktop/src/main/README.md) 负责应用装配与窗口，[renderer](../desktop/src/renderer/README.md) 负责界面 |
| [`crates/`](../crates/README.md) | Rust 业务模块、内部共享能力及 napi 适配层 |
| [`contracts/`](../contracts/README.md) | 跨语言 Protobuf 契约与生成工具 |
| [`gateway/`](../gateway/README.md) | TS／Rust 通信核心及 Electron、Worker、napi 适配 |
| `packages/` | 独立的共享 npm 包 |
| [`server/`](../server/README.md) | 独立 Go HTTP 服务端 |
| `scripts/` | 工作区开发、构建、检查与测试工具；开发启动和重启脚本位于 `scripts/dev/` |
| `deploy/` | 服务端容器部署示例 |

## 工具链与工作区组织

- **pnpm**：统一管理桌面应用、TS 契约、Gateway 和共享 npm 包，并通过 `crates/*/napi` 纳入 Rust 模块的 npm 入口。成员与安装脚本策略见 [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)，依赖解析由 `pnpm-lock.yaml` 固定。
- **Cargo**：管理 Rust 契约、生成工具、Gateway、业务核心及 napi 绑定，成员见根 [`Cargo.toml`](../Cargo.toml)，依赖解析由 `Cargo.lock` 固定。Rust 与 npm 包的关系见 [Rust 模块说明](../crates/README.md)。
- **Go**：`server/` 和 `contracts/go/` 各自维护独立 module，不使用 `go.work`。

工具链版本以配置为准：Node 见 [`.node-version`](../.node-version)，pnpm 见根 [`package.json`](../package.json) 的 `packageManager`，Rust 见 [`rust-toolchain.toml`](../rust-toolchain.toml)，Go 见 [`server/go.mod`](../server/go.mod) 和 [`contracts/go/go.mod`](../contracts/go/go.mod)。just 的 CI 使用版本见 [测试工作流](../.github/workflows/test.yml)。

启动入口见根 [README](../README.md#一键运行)，服务端及其他开发命令见根 [`justfile`](../justfile)。Agent 的开发约束与运行实例规则见 [`AGENTS.md`](../AGENTS.md)。
