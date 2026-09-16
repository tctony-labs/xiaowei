# XiaoWei

## Project Info

当前项目结构、工具链与开发入口见 [工作区开发](docs/workspace.md)，初始化决策与结果见 [初始化项目工作区](.agent/records/active/2026-09-14-setup-workspace.md)。

常用入口：`just prepare`、`just start`、`just rs`、`just server`、`just check`、`just test`、`just build`。格式化使用 `just fmt`，检查不自动修改源码或暂存区。pre-commit 顺序执行格式化和检查；格式化改变待提交文件时需重新暂存，Hook 不自动暂存。

长期说明默认维护在 `.agent/records/active/` 对应事项的 `How` 中；跨多个事项或需要独立查阅的说明，按需提取到 `docs/`，不强制创建该目录。提取后，record 保留理由、取舍和结果，并链接独立文档，避免重复维护。实际架构和行为以当前代码为最终依据；修改模块时，应同步更新承载对应说明的 record 或独立文档。

## 运行实例

- `just start` 使用全局 `~/.xiaowei/.dev.pid`，会停止其中记录的旧开发实例及其子进程，再启动当前工作区；可能影响其他工作区，与旧 `xiaowei-next` 共用此 PID 文件。
- 冷启动由用户执行。Agent 不运行 `just start`、`pnpm dev`、直接 Electron 启动或冒烟脚本等会创建应用实例的入口。
- 重启前先检查活进程，通过进程命令中的绝对路径、cwd 和父子进程关系确认 Electron 与开发监听进程属于当前工作区。不能只凭 `.rs`、PID 文件、端口或应用名称判断实例存活及归属。
- 只有确认当前工作区有运行实例后，Agent 才能执行 `just rs`；它只 touch `desktop/.rs`，由该工作区 nodemon 构建并重启。
- 没有实例时，告知用户当前没有实例及待验证事项，等待用户启动；不要自行冷启动或操作其他工作区进程。

## Coding Agent Skills

仓库开发与排障流程位于 `.agent/skills/`，约定见 [`.agent/skills/README.md`](.agent/skills/README.md)。命中对应任务时，先完整读取该 `SKILL.md`。当前尚未登记 skill。

## Development records

开始非平凡开发事项前，先完整读取 [`.agent/records/README.md`](.agent/records/README.md)，并遵循其中的事项生命周期。理由、取舍和结果维护在 `.agent/records/`，active 事项的 `How` 默认兼作当前有效的长期说明，按需提取独立文档；临时实施步骤维护在 `.agent/plans/`。只有正在实施的 active 事项可以拥有 Plan。事项实施完成或离开 active 时，必须回填 Outcome 和长期文档，并删除对应 Plan。实施完成且成果仍在生效的事项继续留在 active。
