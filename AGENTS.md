# XiaoWei

## Project Info

当前项目结构、工具链与开发入口见 [工作区开发](docs/workspace.md)，初始化决策与结果见 [初始化项目工作区](.agent/records/active/2026-09-14-setup-workspace.md)。

常用入口：`just prepare`、`just start`、`just rs`、`just server`、`just check`、`just test`、`just build`。格式化使用 `just fmt`，检查不自动修改源码或暂存区。pre-commit 顺序执行格式化和检查；格式化改变待提交文件时需重新暂存，Hook 不自动暂存。

## 开发记录与文档

- [`.agent/records/`](.agent/records/README.md)：事项的理由、取舍和结果。长期说明默认维护在 active 事项的 `How` 中；提取到 `docs/` 后，record 保留理由、取舍和结果并链接文档，避免重复维护。
- [`.agent/plans/`](.agent/plans/README.md)：正在实施事项的临时步骤；创建和维护 Plan 时先读取该目录的 README。
- [`docs/`](docs/)：跨多个事项或需要独立查阅的长期说明，描述当前架构、行为和开发约定，按需维护，不要求每个事项都创建独立文档。

开始非平凡开发事项前，先完整读取 [`.agent/records/README.md`](.agent/records/README.md)，并遵循其中的事项生命周期。满足创建条件时，Agent 主动提出创建 record，但必须先说明拟记录的事项和创建理由，获得用户确认后才能新建；用户已明确要求创建该 record 时无需重复确认。事项实施完成或离开 active 时，必须回填 Outcome 和长期文档，并删除对应 Plan；实施完成且成果仍在生效的事项继续留在 active。

实际架构和行为以当前代码为最终依据；修改模块时，应同步更新承载对应说明的 record 或 docs 文档。

## Coding Agent Skills

仓库开发与排障流程位于 `.agent/skills/`，约定见 [`.agent/skills/README.md`](.agent/skills/README.md)。命中对应任务时，先完整读取该 `SKILL.md`。

- [inspect-desktop-logs](.agent/skills/inspect-desktop-logs/SKILL.md)：用户要求查桌面日志，或排查桌面运行异常需要日志证据时使用；覆盖 main、renderer 和 Rust，不用于 Go 服务端。

## 运行实例

- `just start` 使用全局 `~/.xiaowei/.dev.pid`，会停止其中记录的旧开发实例及其子进程，再启动当前工作区；可能影响其他工作区，与旧 `xiaowei-next` 共用此 PID 文件。
- 冷启动由用户执行。Agent 不运行 `just start`、`pnpm dev`、直接 Electron 启动或冒烟脚本等会创建应用实例的入口。
- 重启前先检查活进程，通过进程命令中的绝对路径、cwd 和父子进程关系确认 Electron 与开发监听进程属于当前工作区。不能只凭 `.rs`、PID 文件、端口或应用名称判断实例存活及归属。
- 只有确认当前工作区有运行实例后，Agent 才能执行 `just rs`；它只 touch `desktop/.rs`，由该工作区 nodemon 构建并重启。
- 没有实例时，告知用户当前没有实例及待验证事项，等待用户启动；不要自行冷启动或操作其他工作区进程。

## Rust 原生模块开发

- 修改 Rust 源码（包括内部依赖 crate）、napi 接口或相关依赖与构建配置后，Agent 必须主动构建受影响的 napi 包，生成最新 `.node`、JS 加载入口和类型声明。搜索包执行 `pnpm --filter xiaowei-search build:debug`，剪贴板包执行 `pnpm --filter xiaowei-clipboard build:debug`；修改共享 `xw-napi-log` 时两者都需重建。以后新增模块执行对应包的构建命令。
- `cargo check`、Rust 单测和 TypeScript 检查不能代替原生模块构建。构建失败时先修复，不使用旧产物继续验证新接口。
- 构建成功后，按上面的运行实例规则确认当前工作区实例归属，再执行 `just rs`，让 Electron 加载新模块；已加载的 `.node` 不会随文件更新或前端 HMR 自动替换。
- 没有当前工作区实例时，仍须完成原生模块构建，再告知用户启动后待验证的内容。`just rs` 本身不编译 Rust，不新增自动监听或自动重启机制。

## UI 开发

涉及 UI 的开发或修改，先在 Storybook 中实现并展示本次范围内所有 UI 状态和交互：

- 迁移已有功能时，对齐原有 UI 样式、状态展示和交互，不自行重新设计。
- 新增功能时，根据需求设计并展示组件效果、状态和交互。

两种情况都必须由用户确认后，才能接入项目的实际页面和业务逻辑。不得先接入项目再补 Storybook，或未经确认直接接入。

组件迁移与验收遵循 [UI 对齐与 Storybook](docs/ui-alignment.md)。产品与 Storybook 复用同一组件；修改已接入的共享组件时，确认前不得让未确认的改动直接生效于产品页面。Storybook 可独立启动，不等于桌面冷启动。

## 旧版迁移

迁移前先核对 `xiaowei-next` 对应源码；对齐范围包括业务逻辑、存储、文件生命周期和 UI 交互，不能仅对齐界面。不得自行替换技术方案；无法按旧版实现时，报告具体原因与影响，等待用户决定。已有偏差应明确记录，不得描述为已全面对齐。

不得引入 `@tencent` 下无法从公网下载的 npm 包；旧版私有 UI 依赖按需迁移本地组件或使用公开依赖。
