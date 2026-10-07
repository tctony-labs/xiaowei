# 包和依赖管理

## 新增包

新增 Rust crate 或 npm package 前，先向用户说明用途、边界和放置位置，获得确认后再创建。

Rust 功能入口、业务实现与支撑模块、通用平台能力放在 `crates/`，功能模块的 napi 绑定和 npm 入口留在所属模块的 `napi/` 中；独立共享 npm 包放在 `packages/`。新包加入对应 workspace，通过公开入口提供能力，不为同一 Rust 模块另建 npm 包装目录。

## 依赖管理

工作区通过 `pnpm-lock.yaml` 和 `Cargo.lock` 固定并同步依赖解析结果。依赖变更须由对应包管理工具更新锁文件，锁文件纳入版本控制，不手工修改解析结果。

| 工具 | 管理范围 | 配置与依赖文件 |
| --- | --- | --- |
| pnpm | 桌面应用、TS 契约、Gateway、共享 npm 包与 Rust napi 的 npm 入口 | 各包的 `package.json`、[pnpm-workspace.yaml](../pnpm-workspace.yaml)、`pnpm-lock.yaml` |
| Cargo | Rust 核心、业务支撑模块、通用平台能力、契约、生成工具、Gateway 与 napi 绑定 | 各 crate 及根 [Cargo.toml](../Cargo.toml)、`Cargo.lock` |
| Go | `server/` 和 `contracts/go/` 两个独立 module | 各 module 的 `go.mod` 与 `go.sum` |

工作区 npm 包在消费方声明 `workspace:*` 依赖；Rust crate 使用 Cargo path 依赖。Go 服务端通过 require 与本地 replace 消费契约 module，不使用根 `go.work`。

第三方 npm 补丁通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 登记，补丁制作与升级见 [依赖补丁说明](../patches/README.md)。

## Workspace 源码消费

工作区内部依赖通过已声明的依赖和公开入口直接导入源码，不消费其他包的预构建 `dist`，也不通过跨包私有源码路径或增加预构建绕过源码加载问题。业务模块、开发工具和测试遵循同一规则。

契约包直接导出 TS 源码，Gateway 提供 `source` 条件导出。消费提供条件导出的包时，bundler 显式启用 `source` 条件；Node 使用 `node --conditions=source --import tsx` 或 `tsx --conditions=source`。TS loader 不能替代 exports 条件的选择。

通过 `process.execPath` 启动的源码测试子进程也须显式传递相应条件和 loader，不盲目继承包含 `--test` 的全部父进程参数。同一进程保持统一加载方式，避免出现多份模块身份。

原生 npm 包仍通过 napi 加载对应的 `.node`，相关验证须构建原生模块和桌面自身 worker。包自身的构建产物验收可以构建本包并用 plain Node 检查输出，不启用 `source` 条件；这种验收不为其他业务测试提供依赖包预构建。

## 安装脚本权限

新增带安装脚本的 npm 依赖时，须在 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 的 `allowBuilds` 中显式配置是否允许执行：允许执行设为 `true`，不允许执行设为 `false`，不依赖默认行为或隐式放行。

安装脚本策略变更与依赖变更一样，由 pnpm 同步锁文件。pnpm 安装不自动编译工作区 Rust 模块，原生构建由对应 napi 包的构建入口负责。
