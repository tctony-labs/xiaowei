# XiaoWei

## Documentation

- 放置：同一内容只维护一处，通过链接串联。长期文档按 package 边界放置：跨 package 的架构和完整功能说明放根 [`docs/`](docs/)；包内部的实现和使用说明放对应包目录。包 README 说明用途、准备与运行入口，详细内容放包内 `docs/`。
- 授权：根 [`docs/`](docs/) 仅在用户明确要求，或询问并获得用户授权后，才能新增、修改、移动或删除。
- 根 README：根 [`README.md`](README.md) 由用户维护。新增、移动或删除文档时不要在其中增删或改写链接，仅在用户明确要求时修改。
- 依据：实际架构和行为以当前代码为准。发现文档与代码不一致时，按上述规则进行更新。

## Development Records

开始非平凡开发事项前，先完整读取 [`.agent/records/README.md`](.agent/records/README.md)，并遵循其中的事项生命周期。

- 存放：事项的 why、what、how、进展和结果维护在 `.agent/records/`；当前状态和事实按需维护在 `docs/`；临时实施步骤维护在 `.agent/plans/`。
- 创建：满足创建条件时，Agent 主动提出创建 record，但必须先说明拟记录的事项和创建理由，获得用户确认后才能新建；用户已明确要求创建该 record 时无需重复确认。
- Plan：创建和维护 Plan 时先读取 [`.agent/plans/README.md`](.agent/plans/README.md)。Plan 不要求任务已有 record，不得为了创建 Plan 而擅自新建 record；已有 record 时，只有正在实施的 active 事项可以拥有 Plan。
- 完成：已有 record 的事项实施完成或离开 active 时，必须回填 Outcome，更新相关的当前状态文档，并删除对应 Plan。
- 归档：事项范围已完成并验证，且不再有基于原事项的重大改动时，应向用户提议沉淀长期说明并归档。归档须由用户明确发起或确认，未获确认时保留在 active。成果仍在生效不妨碍完成归档。
- 归档后：record 冻结，长期文档持续更新。

## Coding Agent Skills

仓库开发与排障流程位于 `.agent/skills/`，约定见 [`.agent/skills/README.md`](.agent/skills/README.md)。命中对应任务时，先完整读取该 `SKILL.md`。

- [manage-dev-instances](.agent/skills/manage-dev-instances/SKILL.md)：检查、查询日志或重启当前工作区的客户端与 Go 服务端开发实例时使用；优先通过 cmux 定位并操作 console，无法实现时回退到进程检查、客户端日志文件和既有重启入口。
- [maintain-gateway-contract](.agent/skills/maintain-gateway-contract/SKILL.md)：修改业务 proto service／消息、Rust 模块依赖的 service、Gateway handler 或 typed client 调用时使用；覆盖生成、接入和验证。
- [maintain-agent-session](.agent/skills/maintain-agent-session/SKILL.md)：用户要求查看或清理 Agent 会话数据时使用；`Workflow Inpsect` 按 session ID 定位 SQLite／JSONL 数据，`Workflow Clean` 离线清理会话历史。
- [release-desktop-app](.agent/skills/release-desktop-app/SKILL.md)：准备或发布桌面 App、执行本地打包与更新联调时使用；维护版本与更新说明，推送 tag 触发发布，跟踪 CI 并验证安装包和自动更新。
- [depoly-server](.agent/skills/depoly-server/SKILL.md)：用户明确要求部署服务器时使用；手动触发 server 镜像构建，关联本次产物并执行配置预检查、生产部署和上线验收。

## 运行实例

实例检查、日志读取及重启优先使用 cmux，具体流程与回退方式见 [manage-dev-instances](.agent/skills/manage-dev-instances/SKILL.md)。

- `just start` 使用全局 `~/.xiaowei/.dev.pid`，会停止其中记录的旧开发实例及其子进程，再启动当前工作区；可能影响其他工作区，与旧 `xiaowei-next` 共用此 PID 文件。
- 服务端入口为 `just server`，由用户冷启动；它先准备本地配置并检查 HTTP 端口，完成接管确认后确保共享 PostgreSQL 就绪，再启动本机 Go 服务端。运行 console 支持 `r` 重启 Go，退出不停止数据库；共享 PostgreSQL 通过 `just db start|stop|restart|status` 独立管理，具体行为见 [服务端本地开发](server/README.md#本地开发)。
- 冷启动由用户执行。Agent 不运行 `just start`、`pnpm dev`、直接 Electron 启动或冒烟脚本等会创建应用实例的入口。
- 重启前先检查活进程，通过进程命令中的绝对路径、cwd 和父子进程关系确认 Electron 与开发监听进程属于当前工作区。不能只凭 `.rs`、PID 文件、端口或应用名称判断实例存活及归属。
- 只有确认当前工作区有运行实例后，Agent 才能执行 `just rs`；它只 touch `desktop/.rs`，由该工作区 nodemon 依次构建所有 napi 包、main/preload 并重启；构建失败不启动 Electron。
- 没有实例时，告知用户当前没有实例及待验证事项，等待用户启动；不要自行冷启动或操作其他工作区进程。

## 工作区及模块

- 创建或修改 `contracts/proto/xiaowei/` 下的业务契约前，先完整读取并遵循 [业务契约的创建与维护](contracts/proto/xiaowei/README.md)。
- 修改 Rust 模块、napi 接口或相关依赖与构建配置前，先完整读取并遵循 [Rust 原生模块开发](crates/README.md)。调整模块边界或接入方式时同步更新该 README。
- 新增或修改 `desktop/src/main/` 下的代码前，先完整读取 [main 模块组织](desktop/src/main/README.md)，遵循其中的目录职责、service 边界和 Gateway 调用规则。调整模块边界时同步更新该 README。
- 新增或修改 renderer UI、样式、状态展示及交互前，先完整读取并遵循 [Renderer UI 开发](desktop/src/renderer/README.md)。调整通用开发与验收约定时同步更新该 README。
- 新增或修改 `server/` 下的代码、配置或部署文件前，先完整读取并遵循 [服务端开发](server/README.md)。
- 新增或修改客户端与服务器之间的接口前，先完整读取并遵循 [xwapi 服务器调用](docs/xwapi.md)，按其中的契约声明、HTTP／WebSocket 路由、登录态与传输约定实现。
- 新增或调整工作区包、依赖、包入口，或修改构建与测试中的源码加载方式前，先完整读取并遵循 [包和依赖管理](docs/package-management.md)。

其他或更详细的目录结构、模块关系与工具链组织见 [工作区详情](docs/workspace.md)。

## 手写代码的排版与可读性

- 手写源码、协议定义、配置和测试脚本以清晰易读、便于 diff 为优先，不为减少行数压缩声明、语句或空白。Agent 编写的代码同样属于手写代码，不属于生成器产物。
- 独立声明、函数和不同逻辑阶段之间保留适当空行；不要把多条独立语句挤在一行。脚本中作为字符串执行的代码也遵循相同要求。
- Proto 使用 2 空格缩进，每个字段、枚举值和 RPC 声明各占一行；`syntax`、`package`、import 组及各 message／enum／service 之间留空行。空消息可以写成 `message Empty {}`。
- 经常追加项目的配置列表（如 Cargo workspace `members`）采用多行形式，每项一行，避免新增一项改动整行。
- 格式化／lint 通过不代表可读性合格。交付前检查本次修改的手写代码，补齐工具不会自动处理的逻辑分段和排版；不顺带格式化无关代码。
- 生成器产物不纳入人工排版检查，不为美化排版直接修改产物；源定义变化后通过既有生成流程同步，保留生成一致性检查。

## 其他事项

迁移前先核对 `xiaowei-next` 对应源码；对齐范围包括业务逻辑、存储、文件生命周期和 UI 交互，不能仅对齐界面。不得自行替换技术方案；无法按旧版实现时，报告具体原因与影响，等待用户决定。已有偏差应明确记录，不得描述为已全面对齐。

不得引入 `@tencent` 下无法从公网下载的 npm 包；旧版私有 UI 依赖按需迁移本地组件或使用公开依赖。
