# 初始化项目工作区

## Why

XiaoWei 是开源个人效率工具，以搜索和 AI Agent 帮助用户获取信息、处理任务；剪贴板与个人知识库是具体应用形式。仓库同时承载客户端和可自部署的服务端，需要明确多语言工程的目录及职责，作为后续初始化和功能迁移的依据。

## What

本事项旨在初始化项目工作区，落实仓库布局、pnpm 工作区、Go module、桌面与服务端最小工程，以及 justfile 开发入口。

完成标准：依赖和工具链版本可复现；桌面端与 Go 服务端的最小运行链路可验证；提供初始化所需的最小开发入口，并验证其与实际工程一致。

不在本事项迁移完整业务，也不实现微信登录、收藏同步或加密。移动端技术栈、数据库选型及具体业务协议另行设计。

## How

工作区已落地，当前结构、工具链、运行命令、进程边界与验证方式维护在 [工作区开发](../../../docs/workspace.md)，此处保留初始化决策与结果。

- 桌面端位于根 `desktop/`，采用 Electron + TS + React + Tailwind CSS + Zustand；应用标识为 `com.tctony.xiaowei`。
- 当前不引入 Rust 工程、原生模块或 sidecar；有实际需求时再接入。
- Go 服务端位于 `server/`，使用独立 module，当前只有健康检查 HTTP 服务。
- 根 pnpm 工作区与格式配置统一管理各自生态，justfile 提供已经验证的最小开发入口。
- `packages/` 保留为独立 npm 包目录，没有创建无用途的示例包；`protocol/` 与 `deploy/` 分别存放最小协议说明和服务端部署示例。
- `mobile/` 留待实际开发，未创建空工程。独立开发文档在工程落地后提取到 `docs/`，不在 record 重复维护当前事实。
- 开发数据按工作区隔离，`just start` 通过全局 PID 切换运行实例；格式化与只读检查分开，不引入自动暂存、提交或内部项目依赖。

## Alternatives considered

- `apps/desktop/`：不采用；桌面端直接放在根目录，后续移动端与其并列。
- Node.js 服务端：便于共享 TypeScript，但部署与资源占用不符合本项目的优先考虑，改用 Go。
- Rust 服务端：资源控制好，但最小服务工程与后续常规 Web 开发选择 Go 更直接；客户端 Rust 集成暂缓。

## Outcome

已完成 pnpm 工作区与 Go module、Electron 最小页面与 Logo、preload 入口及 Go 健康检查。工具链版本与依赖锁文件已落地，开发入口见工作区文档。

验证环境为 macOS arm64：

- frozen lockfile 安装、`just check`、`just test`、`just build` 通过；相关集成测试与 Go 路由及方法子测试通过。
- 真实 Electron 构建页面与 Vite 开发页面均通过冒烟测试；renderer Node 隔离、页面与 Logo 加载正常，浅色/深色截图已人工查看。
- Go 二进制以系统分配端口实际监听，HTTP 健康检查和 SIGTERM 正常退出通过。
- macOS 目录包生成成功，已核对 `com.tctony.xiaowei`；未执行个人签名、公证或发布。

附带 Docker/Compose 最小部署示例，但本机无 Docker，未验证容器运行；Windows/Linux 平台验证、业务迁移和正式发布属于后续工作。README 保持简短产品介绍，未导入原内部项目代码或配置。事项成果继续生效，保留在 active；对应实施 Plan 已删除。

后续补齐提交与检查入口：按用户要求通过 Husky 在 pre-commit 中执行格式化与检查，格式化改变待提交文件时中止并要求重新暂存；类型检查改用固定版本 tsgo，保留 TypeScript 工具依赖。显式忽略当前未使用的 electron-winstaller 安装脚本。已验证 tsgo 全仓检查和临时仓库中 Hook 的执行顺序、失败中止、格式化变更提示及暂存区保持不变。

按用户收窄当前范围，已移除 Rust 工程、原生模块、编译脚本和示例连接状态。保留前端 HMR，main/preload 修改不自动编译，`just rs` 通过 touch `.rs` 触发 nodemon 重新构建并启动当前实例；`just server` 独立启动 Go。静态检查通过，已确认 main 修改不自动编译；`rs` 触发重启尚未验证通过。当前工作区没有运行实例，按用户要求不冷启动，运行验证待用户启动后继续。开发实例操作边界已写入 AGENTS.md。

按用户提供的旧项目流程调整 `start`：先准备依赖，再停止全局 PID 对应的旧进程树，启动当前工作区并在退出时清理。沿用 `~/.xiaowei/.dev.pid`，与旧项目共用。此次仅执行配方解析与 Bash 语法检查，未启动或停止任何实例；运行验证仍由用户启动后进行。

修复首次页面加载被刷新取消时错误退出：仅忽略 `ERR_ABORTED`，保留其他加载失败处理。排查 `rs` 时确认当前工作区实例存活，但 touch 后 Electron PID 未变化；隔离临时文件验证默认监听未收到 touch 事件，而轮询收到 change，故 nodemon 改用 `--legacy-watch`。监听参数需用户重新启动开发入口后生效，实际应用重启仍待验证，Agent 未执行冷启动。

按用户要求移除 `--legacy-watch`，恢复 nodemon 默认文件事件监听；此前轮询方案不再采用。开发监听参数由用户下次运行 `start` 时加载。

默认 FSEvents 监听失效的根因尚未确定；按用户决定，当前恢复 `--legacy-watch`，使用默认 100ms 轮询作为临时方案。此决定取代上面的恢复默认监听决定。
