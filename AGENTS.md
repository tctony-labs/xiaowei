# XiaoWei

## 开发记录与文档

- [`.agent/records/`](.agent/records/README.md)：事项的理由、取舍和结果。长期说明默认维护在 active 事项的 `How` 中；提取到 `docs/` 后，record 保留理由、取舍和结果并链接文档，避免重复维护。
- [`.agent/plans/`](.agent/plans/README.md)：正在实施事项的临时步骤；创建和维护 Plan 时先读取该目录的 README。
- [`docs/`](docs/)：跨多个事项或需要独立查阅的长期说明，描述当前架构、行为和开发约定，不要求每个事项都创建独立文档。仅在用户明确指令要求，或询问并获得用户授权后，才能新增、修改、移动或删除该目录下的文档；其他规范中的文档同步要求不视为自动授权。

开始非平凡开发事项前，先完整读取 [`.agent/records/README.md`](.agent/records/README.md)，并遵循其中的事项生命周期。满足创建条件时，Agent 主动提出创建 record，但必须先说明拟记录的事项和创建理由，获得用户确认后才能新建；用户已明确要求创建该 record 时无需重复确认。事项实施完成或离开 active 时，必须回填 Outcome 和长期文档，并删除对应 Plan；实施完成且成果仍在生效的事项继续留在 active。

实际架构和行为以当前代码为最终依据；修改模块时，应同步更新承载对应说明的 record 或 docs 文档。

## Coding Agent Skills

仓库开发与排障流程位于 `.agent/skills/`，约定见 [`.agent/skills/README.md`](.agent/skills/README.md)。命中对应任务时，先完整读取该 `SKILL.md`。

- [inspect-desktop-logs](.agent/skills/inspect-desktop-logs/SKILL.md)：用户要求查桌面日志，或排查桌面运行异常需要日志证据时使用；覆盖 main、renderer 和 Rust，不用于 Go 服务端。
- [maintain-gateway-contract](.agent/skills/maintain-gateway-contract/SKILL.md)：修改业务 proto service／消息、Rust 模块依赖的 service、Gateway handler 或 typed client 调用时使用；覆盖生成、接入和验证。

## 运行实例

- `just start` 使用全局 `~/.xiaowei/.dev.pid`，会停止其中记录的旧开发实例及其子进程，再启动当前工作区；可能影响其他工作区，与旧 `xiaowei-next` 共用此 PID 文件。
- 冷启动由用户执行。Agent 不运行 `just start`、`pnpm dev`、直接 Electron 启动或冒烟脚本等会创建应用实例的入口。
- 重启前先检查活进程，通过进程命令中的绝对路径、cwd 和父子进程关系确认 Electron 与开发监听进程属于当前工作区。不能只凭 `.rs`、PID 文件、端口或应用名称判断实例存活及归属。
- 只有确认当前工作区有运行实例后，Agent 才能执行 `just rs`；它只 touch `desktop/.rs`，由该工作区 nodemon 依次构建所有 napi 包、main/preload 并重启；构建失败不启动 Electron。
- 没有实例时，告知用户当前没有实例及待验证事项，等待用户启动；不要自行冷启动或操作其他工作区进程。

## 手写代码的排版与可读性

- 手写源码、协议定义、配置和测试脚本以清晰易读、便于 diff 为优先，不为减少行数压缩声明、语句或空白。Agent 编写的代码同样属于手写代码，不属于生成器产物。
- 独立声明、函数和不同逻辑阶段之间保留适当空行；不要把多条独立语句挤在一行。脚本中作为字符串执行的代码也遵循相同要求。
- Proto 使用 2 空格缩进，每个字段、枚举值和 RPC 声明各占一行；`syntax`、`package`、import 组及各 message／enum／service 之间留空行。空消息可以写成 `message Empty {}`。
- 经常追加项目的配置列表（如 Cargo workspace `members`）采用多行形式，每项一行，避免新增一项改动整行。
- 格式化／lint 通过不代表可读性合格。交付前检查本次修改的手写代码，补齐工具不会自动处理的逻辑分段和排版；不顺带格式化无关代码。
- 生成器产物不纳入人工排版检查，不为美化排版直接修改产物；源定义变化后通过既有生成流程同步，保留生成一致性检查。

## 工作区及模块

- 调整工作区目录、工具链、依赖管理或构建流程前，先完整读取并遵循 [工作区开发](docs/workspace.md)，变更后同步更新该文档。
- 开发过程中拟新增 Rust crate 或 npm package 时，先向用户说明其用途、边界和放置位置，获得确认后再创建。
- 创建或修改 `contracts/proto/xiaowei/` 下的业务契约前，先完整读取并遵循 [业务契约的创建与维护](contracts/proto/xiaowei/README.md)。
- 新增或修改 `desktop/src/main/` 下的代码前，先完整读取 [main 模块组织](desktop/src/main/README.md)，遵循其中的目录职责、service 边界和 Gateway 调用规则。调整模块边界时同步更新该 README。
- 新增或修改 renderer UI、样式、状态展示及交互前，先完整读取并遵循 [Renderer UI 开发](desktop/src/renderer/README.md)。调整通用开发与验收约定时同步更新该 README。
- 修改 Rust 模块、napi 接口或相关依赖与构建配置前，先完整读取并遵循 [Rust 原生模块开发](crates/README.md)。调整模块边界或接入方式时同步更新该 README。

## 其他事项

迁移前先核对 `xiaowei-next` 对应源码；对齐范围包括业务逻辑、存储、文件生命周期和 UI 交互，不能仅对齐界面。不得自行替换技术方案；无法按旧版实现时，报告具体原因与影响，等待用户决定。已有偏差应明确记录，不得描述为已全面对齐。

不得引入 `@tencent` 下无法从公网下载的 npm 包；旧版私有 UI 依赖按需迁移本地组件或使用公开依赖。
