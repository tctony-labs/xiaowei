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
- 开发与打包共用 `com.tctony.xiaowei` 数据目录，不按工作区或 tag 隔离，`just start` 通过全局 PID 切换运行实例；格式化与只读检查分开，不引入自动暂存、提交或内部项目依赖。

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

2026-09-20 增加开发终端命令：`R` 重建整个 Vite/Electron 开发子进程，`r` 复用 `.rs` → nodemon 重启 Electron，`h` 从命令表生成帮助。父进程持有终端输入，后台启动显式保留 stdin；完整重启等待旧进程关闭，清除插件模块缓存。保留 Agent 使用的 `just rs`。实现说明见工作区文档。新增测试覆盖大小写命令、帮助、串行重启、退出中断、raw mode 恢复、非 TTY 与失败后重试；未启动新应用实例，真实终端按键及应用重启需用户重新执行 `just start` 后验收。

随后排查“启动日志缺失”：旧 Electron 的 cwd 属于当前工作区，但父 pnpm 已被系统接管，新实例因单实例锁立即退出。清理该旧实例并通过已运行的 nodemon 执行 `just rs` 后，17:36:07 的 main/renderer 启动日志恢复。`just start` 的进程树清理增加先暂停父进程的步骤，防止停止子进程时监控器重新拉起应用；新增真实的自动重启监控器／子进程回归测试，验证清理后无替代子进程遗留，6 项开发入口测试通过。未冷启动应用。

继续修复 `R` 重启的遗留进程问题：nodemon 的 close 不代表 pnpm/Electron 后代已退出，之前仅等待 nodemon 的判断不足。现在以独立 POSIX 进程组启动 nodemon，退出时等待整个组消失，超时升级信号；旧开发进程异常退出时取消本次自动启动。使用真实 nodemon → pnpm → 测试应用验证延迟退出及忽略 SIGTERM 两种情形，确认后代和进程组均消失后才返回，9 项开发入口测试通过。实际 Electron 的连续 R 重启仍需加载新入口后验收。

修复 Ctrl+C 停止时的 Vite CSP 错误：Vite 的 `waitForSuccessfulPing` 在 HMR 断开后创建 blob SharedWorker，此前缺少 worker-src，回退到 script-src 后被阻止。仅开发态 CSP 新增 `worker-src 'self' blob:`，正式 HTML 保持原 CSP。

补齐终端操作标记与退出验证：`R/r/h/Ctrl+C` 执行前输出分隔线和命令说明；用户退出与重启失败分开处理，退出期间重复信号共用同一次清理，避免未捕获异常。新增完整开发会话测试，以真实 nodemon/pnpm 和测试应用执行两次 R 再 Ctrl+C，验证旧进程组消失且无遗留应用；12 项开发入口测试通过。清理了之前未采用独立进程组的旧遗留 Electron。开发态 CSP 与正式构建 CSP 已分别检查，只有开发态允许 blob worker。

定位并修复正常 R 重启返回 143：Vite 自带 SIGTERM 监听器会主动结束其宿主进程，与自定义异步清理竞争。正常停止改为父子进程 IPC 请求，不再给 Vite 宿主发送 SIGTERM；先等待应用进程组退出，再关闭 Vite、断开 IPC，正常返回 0。完整会话测试改用真实 Vite（此前以替身代替，未覆盖该冲突），结合真实 nodemon/pnpm 和测试应用验证连续两次 R、Ctrl+C、进程组清空及无重启错误。当前未检测到实际开发/Electron 残留实例；实际 Electron 仍需用户启动后验收。

主动停止输出处理：保留进程组退出机制，仅在 Ctrl+C / R 主动停止旧实例期间过滤 pnpm 的 `ELIFECYCLE Command failed.` 和 macOS Electron CLI 的 `exited with signal SIGTERM` 两类预期提示；运行期同类输出、退出阶段其他错误及应用清理日志继续输出。新增输出过滤回归测试，并在真实 Vite/nodemon/pnpm 与测试应用的连续 R / Ctrl+C 测试中验证过滤及进程清理，14 项相关测试通过；未冷启动 Electron，实际终端表现待用户重新启动开发入口后验证。

修复退出提示过滤引入的日志颜色回归：管道使 electron-log 的 isTTY 检测失效，且该库不读取 FORCE_COLOR。日志配置现显式将 FORCE_COLOR 转为布尔 useStyles，并支持 NO_COLOR；输出过滤保留原始 ANSI，文件日志仍无颜色控制码。管道模式下默认／禁用／启用颜色、main/renderer 输出及过滤转发共 12 项相关测试通过，桌面 TypeScript 检查通过；未启动 Electron。

修复 start 切换实例只等待根 pnpm 的漏洞：清理前暂停并快照整个进程树，退出信号发送后等待所有记录 PID（包括独立进程组和已被接管的后代），6 秒后强制终止残留，约 10 秒后仍有残留则取消启动。新增根进程先退出、独立后代延迟退出及忽略 SIGTERM 的真实子进程测试，11 项开发控制测试通过，just 配方解析通过。当前活实例与 PID 文件归属已核对为 prometheus；未停止该实例或冷启动应用，跨工作区实际切换待用户验证。

按开发工具边界整理目录：dev、dev-session、dev-process、dev-output 移至根 scripts，对应控制／进程／输出测试及 Gateway 构建解析测试移至 scripts/tests。增加根 test:tooling 入口并纳入 pnpm test，开发工具依赖在根声明；desktop dev 仅调用根入口，工作目录与 .rs 路径显式指向 desktop。迁移后 17 项工具测试通过，业务测试入口独立保留。

完成工具／产品测试目录整理：移除 desktop/scripts；构建与 benchmark 入口归入根 scripts，桌面模块测试归入 desktop/tests，真实应用冒烟归入 desktop/tests/e2e，Gateway Electron 验收归入 gateway/tests/electron 并声明独立测试依赖。工具解析测试改名为 desktop-source-resolution.test.mjs；共享 source-log 的 Vite/runtime 测试回归包内。调用入口和文档同步，prepare 检测新增测试包清单。17 项工具测试、23 项桌面测试、8 项 source-log 测试及 just check 通过；main/preload 构建、完整 benchmark、Gateway 验收资产构建通过。未执行会启动 Electron 的冒烟或实际 Electron 验收，未修改产品业务逻辑。

补齐开发重启的原生构建：共用 `build-desktop-main.mjs` 在 main/preload 前依次执行所有 napi 包的 debug 增量构建，覆盖 `just rs`、终端 `r`／`R` 与应用内 `rs`；构建失败即退出，不加载旧原生产物。移除 `just start` 的重复预构建，首次启动和重启统一通过共用入口，每个 napi 包只构建一次；首次构建失败时旧实例已停止，新 Electron 不会启动。已验证两个 napi 包及 main/preload 构建成功、注入原生构建失败时保留退出码并跳过后续构建；当前工作区执行 `just rs` 后，两份 `.node` 的更新时间晚于 `.rs`，Electron PID 更新且原生日志、剪贴板监听和搜索初始化正常。当前行为与无实例边界已同步工作区文档及 AGENTS.md。

开发调用链集中到 `scripts/dev/`：迁移 dev、session、process、output、桌面构建与原生构建脚本，原生构建脚本改名 `build-napi.mjs`；四个工具测试与目标模块并排放置，移除空的 `scripts/tests/`。同步 desktop、两个 napi 包、test:tooling 的入口与文档引用；保留 benchmark 和 pre-commit 在 scripts 根目录。17 项工具测试通过（源码解析测试需先生成 Gateway dist），新路径下两个 napi 包及 main/preload 构建、Biome 和差异检查通过。验证期间已观察到当前工作区运行新路径下的 `scripts/dev/dev-session.mjs` 和 `dev:main`，Electron、剪贴板监听及搜索初始化正常。

切换实例优先 graceful shutdown：`just start` 直接启动 `node scripts/dev/dev.mjs`，使全局 PID 指向退出协调进程。原来的后台 pnpm 命令让 `$!` 指向包装进程，退出依赖其信号转发和等待行为；直接运行 Node 后可将 SIGTERM 交给 dev.mjs，可靠进入已有的 stop／IPC 流程。session 的工作目录由 dev.mjs 显式设置，不依赖 pnpm 的 `--dir`。清理先记录进程树并只向根进程发送 SIGTERM，复用 Ctrl+C 的 stop／IPC 流程，最多等待 6 秒；残留进程才进入冻结、逐层 SIGTERM 与超时 SIGKILL 的兜底流程，保留对旧入口及被接管后代的清理能力。新增真实子进程回归，验证 dev 控制进程收到信号后通过 IPC 等待 session 正常退出，session 未收到提前终止信号。18 项工具测试、just 配方解析、Bash 语法及差异检查通过；未切换或冷启动实际桌面实例，新启动入口由用户下次执行 `just start` 加载。

补齐外部停止的终端提示：此前 SIGTERM／SIGINT 直接调用 stop，只有 Ctrl+C 按键打印退出标记，切换工作区时旧终端缺少解释。现在外部信号先打印信号名和停止提示，正常清理完成后打印退出完成；重复信号不重复标记，不推断信号发送方工作区。20 项工具测试通过，覆盖非 TTY 的两种信号、重复信号及真实控制进程的 IPC 清理与提示顺序，Biome 和差异检查通过。未启动或停止其他工作区实例；dev 控制进程需用户重新执行 just start 后加载新提示。Chromium network service 提示保留，现有证据不足以单独确定其终止来源。
