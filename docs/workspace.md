# 工作区开发

当前工程提供 Electron Launcher、Rust 全局搜索核心与独立 Go HTTP 服务。

## 目录与工具链

| 位置 | 职责 |
| --- | --- |
| `desktop/src/main/` | Electron 生命周期与窗口 |
| `desktop/src/preload/` | 沙箱 renderer 可调用的受限 API |
| `desktop/src/renderer/` | React、Tailwind CSS Launcher 搜索框；已安装 Zustand |
| `desktop/resources/logo-clear.png` | 搜索框在明暗主题下共用的透明 Logo |
| `desktop/resources/logo.png` | 用户提供的原始 Logo，供打包器使用 |
| `scripts/`、`scripts/dev/` | 性能测量、提交工具；开发启动、构建及并排放置的回归测试 |
| `desktop/tests/*.test.mjs` | 桌面应用模块测试，由 desktop 的 test 命令执行 |
| `packages/source-log/test/` | 日志源码定位包的 Vite、Babel、runtime 测试 |
| `gateway/tests/electron/` | Gateway 真实 Electron 环境集成验收，单独显式执行 |
| `desktop/tests/e2e/smoke.mjs` | 使用真实 Electron 的端到端冒烟入口，不随应用打包 |
| `server/cmd/xiaowei-server/` | Go 进程入口、监听与信号退出 |
| `server/internal/httpapi/` | HTTP 路由及测试 |
| `crates/xiaowei-search/` | 全局搜索核心及 `napi/` npm 入口 |
| `crates/xiaowei-clipboard/` | 本地剪贴板存储、监听与 `napi/` npm 入口 |
| `crates/xw-napi-log/` | 各 Rust 原生模块复用的日志接收器 |
| `crates/xw-platform/` | 内部系统能力：应用名称、原生图标、macOS 主题切换 |
| `crates/xw-app/`、`crates/xw-bookmark/` | 应用和 Chrome 书签数据源 |
| `contracts/` | Protobuf 消息与接口描述的 TS／Rust／Go 契约包及固定版本生成工具，见 [契约说明](../contracts/README.md) |
| `gateway/` | TS／Rust Gateway 核心、PB 绑定、可选 napi 适配及联调测试，尚未迁移产品业务通信；见 [Gateway 核心](../gateway/README.md) |
| `packages/` | 独立 npm 包的位置，目前无包，仅保留目录 |
| `protocol/` | 跨端协议说明，目前只有健康检查，无业务协议 |
| `deploy/` | Go 容器部署示例 |

根 pnpm workspace 包含 `desktop`、`contracts/ts`、`gateway/ts`、`packages/*` 与 `crates/*/napi`。Rust 核心与 napi 包的分层及构建约定见 [Rust 模块接入](rust-napi.md)。Go 在 `server/` 与 `contracts/go/` 中分别管理，不使用 `go.work`。`mobile/` 尚未创建。

当前使用 Node **26.3.1**（`.node-version`）、pnpm **12.4.2**（根 `package.json`）、Go **1.26.5**（`server/go.mod`）。Node 的 engines 限定为 26.x；Go module 声明 1.26.0 的语言版本并选择 1.26.5 工具链。just 在本机以 **1.46.0** 验证。

Electron **44.3.0**、electron-vite **5.0.0**、Vite **7.3.6**、TypeScript **5.9.3**、React **19.3.0**、Tailwind CSS **4.3.3** 和 Zustand **5.0.8** 由包清单与 `pnpm-lock.yaml` 固定依赖解析。Vite 使用 electron-vite 支持的 7.x。类型检查使用固定版本的 `@typescript/native-preview` **7.0.0-dev.20260707.2** 提供的 tsgo；保留 TypeScript 5.9.3 作为工具生态配套依赖。

`pnpm-lock.yaml` 提交到仓库，由工具生成；Go 当前仅依赖标准库，没有 `go.sum`。pnpm 12 安装脚本策略在 `pnpm-workspace.yaml` 的 `allowBuilds` 一处配置：Electron、esbuild 为 `true`，当前未使用的 Squirrel.Windows 依赖 `electron-winstaller` 为 `false`。策略随仓库共享，新 clone 无需交互执行 `pnpm approve-builds`；新增带安装脚本的依赖时，需要明确配置其布尔值。Electron 44 的运行时可能在第一次启动时下载，需要网络。

## 开发入口

先准备 Node、pnpm、Go 和 just，由用户在根目录运行：

```sh
just start
```

`just start` 先执行 `just prepare`；安装失败时直接退出，不停止旧实例。准备成功后，通过全局 `~/.xiaowei/.dev.pid` 停止上一个开发实例的进程树，并启动当前工作区的独立 Vite 开发服务器与 nodemon，共用启动入口依次增量构建所有 napi 包、构建 main/preload 后启动 Electron，每个包只构建一次。构建失败时旧实例已停止，新 Electron 不会启动，修复后可执行 `just rs` 重试。React 页面支持 HMR，Vite 使用 100ms 轮询避免本机文件事件丢失导致缓存不更新；main/preload 源码修改不自动编译或重启，在另一个终端执行 `just rs` 后才依次增量构建 napi、编译 main/preload 并重启当前工作区 Electron。Vite 服务保持运行，只监听 `127.0.0.1`，默认从 5173 选择可用端口。

另一个终端可独立运行服务端：

```sh
just server
```

默认监听 `127.0.0.1:8080`。通过进程环境 `XIAOWEI_LISTEN_ADDR` 修改监听地址，例如使用 `127.0.0.1:0` 由系统分配空闲端口，实际地址会写入日志。`server/.env.example` 仅说明配置，不自动加载 dotenv。`GET /healthz` 返回 `{"status":"ok"}`，SIGINT/SIGTERM 触发最多 5 秒的优雅退出。

当前主窗口为 Launcher 搜索框，macOS 固定使用 Cmd+Space 唤起搜索、Cmd+Shift+X 唤起剪贴板；同模式已显示并聚焦时再次按下隐藏，跨模式则切换，暂不提供自定义快捷键。支持失焦与 Esc 隐藏；已接入 Rust 计算器、macOS 应用／系统设置及 Chrome Default profile 书签搜索，尚未连接 Go 服务端。交互说明见 [迁移 Launcher](../.agent/records/active/2026-09-16-migrate-launcher.md)。

## 提交检查

根 `package.json` 的 `prepare` 生命周期通过 Husky 安装 `.husky/pre-commit`；`just prepare` 安装依赖时会一并启用，Git 的 `core.hooksPath` 指向 `.husky/_`。生成的 `.husky/_/` 不提交。

pre-commit 通过 `scripts/pre-commit.mjs` 顺序运行 `just fmt` 和 `just check`，任一步失败即阻止提交。若格式化改变了待提交文件，检查通过后仍会中止，提示检查并重新暂存，以免提交格式化前的版本。Hook 不自动 `git add`，保留部分暂存边界；检查针对当前工作区内容，并非暂存区的独立构建。

`pnpm install --frozen-lockfile` 只按锁文件安装，清单与锁文件不一致时失败。`Already up to date` 表示依赖已经齐全。`pnpm approve-builds` 用于决定哪些依赖可以执行安装脚本，不是项目编译命令；无需对当前忽略的 `electron-winstaller` 全选放行。以后启用 Squirrel.Windows 打包时再评估该脚本。

开发终端支持直接按键（无需回车）：`R` 依次关闭 Electron/nodemon 和 Vite，再创建新的开发子进程，重新加载 Vite 配置及插件并启动 Electron；`r` 通过 touch `.rs` 重建 main/preload 并重启 Electron；`h` 显示命令列表，后续命令统一注册在 `dev.mjs` 的命令表中；`Ctrl+C` 退出并恢复终端输入模式。每个终端命令执行前打印分隔线、按键和命令说明，帮助列表从同一命令表生成。重启命令串行执行，退出会取消尚未执行的命令；退出过程重复收到信号时等待同一次清理，不将用户退出误报为重启失败。非 TTY 环境不接管输入，仍保留信号退出与 `.rs` 重启入口。

开发启动、重启和原生构建脚本集中在 `scripts/dev/`，对应回归测试与目标模块并排放置。主要入口如下：

- `scripts/dev/build-desktop-main.mjs`：依次构建 napi 包和 main/preload，首次启动、`r` 和 `R` 共用此入口，Rust 使用增量编译。
- `scripts/dev/desktop-source-resolution.test.mjs`：验证桌面源码解析配置。工具回归测试通过 `pnpm test:tooling` 运行，也纳入根目录 `pnpm test`；desktop 的业务测试入口保持独立。
- `scripts/benchmark-log-source.mjs`：测量日志源码定位的性能开销，与提交 Hook 一同留在 `scripts/` 根目录。性能测量不随工具回归测试运行。

桌面构建和日志性能测量脚本均显式定位 desktop 工作目录。`just start` 直接运行 `node scripts/dev/dev.mjs`，保留后台进程的 stdin，全局 PID 指向该开发控制进程。修改 `dev.mjs` 本身后，需要重新运行 `just start`。

这里直接运行 Node，是为了让 `$!` 和 PID 文件准确指向负责退出协调的 `dev.mjs`。原来的 `pnpm --dir desktop dev &` 记录的是 pnpm 的 PID，运行 `dev.mjs` 的 Node 是其后代；向 pnpm 发送 SIGTERM 不会由操作系统自动传播到整棵进程树，能否通知并等待 Node 退出取决于 pnpm 的行为。直接启动后，停止旧实例的信号交给 `dev.mjs`，由它复用 Ctrl+C 的 stop／IPC 流程，按顺序等待应用和 Vite 关闭。`dev.mjs` 已显式设置 session 的 desktop 工作目录，不依赖 `pnpm --dir`。

`dev.mjs` 独占终端输入，`dev-session.mjs` 子进程负责 Vite 与 nodemon，不读取 stdin。nodemon 与它启动的应用处于独立 POSIX 进程组，退出时必须等待整个组消失，包括已被系统接管的后代，不能仅凭 nodemon 退出判断应用已停止。

开发控制进程收到外部 `SIGTERM`／`SIGINT` 时，先打印带信号名称的“收到外部停止请求，正在退出开发实例”标记；正常清理完成后打印“开发实例已退出”。重复信号复用同一次退出，不重复打印标记。信号本身不携带发起工作区信息，因此提示不推断请求来源；`SIGKILL` 无法被进程捕获或打印提示。

开发控制进程通过 IPC 请求 session 停止，避免直接向 Vite 发送 SIGTERM 触发其立即退出处理。session 先向应用进程组发送 SIGTERM，5 秒仍未退出则发送 SIGKILL；清理完成后关闭 Vite，最后断开 IPC 并正常退出。`R` 等待旧 session 退出后再创建新的 session，重新加载插件模块，并把新的 Vite URL 传给 Electron。Vite 启动失败后，可修正配置再按 `R` 重试。

切换实例时，`just start` 按以下顺序停止旧实例：

1. 记录旧实例的进程树，只向开发控制进程发送 SIGTERM，复用 Ctrl+C 的 IPC 退出流程；最多等待 6 秒，并确认快照中的后代也已退出。
2. 若有残留，暂停并收集残留进程及其子进程，自底向上发送 SIGTERM。
3. 再等 6 秒仍未退出则发送 SIGKILL；兜底阶段约 10 秒仍未完成则取消启动。

旧版 pnpm 入口不依赖信号转发保证，未退出的后代由兜底流程清理。

主动停止旧实例时，仅过滤 pnpm 的 `ELIFECYCLE Command failed.` 和 Electron CLI 的 `exited with signal SIGTERM` 提示；其他日志及错误继续输出，非主动停止期间不做过滤。输出经管道转发时保留 ANSI 颜色，开发入口传递 `FORCE_COLOR`，应用日志遵循该设置及 `NO_COLOR`；日志文件仍为纯文本。

`just rs` 执行 `touch desktop/.rs`。nodemon 使用 `--legacy-watch` 轮询 `.rs`（默认间隔 100ms），收到变更后停止自己启动的应用，依次执行所有 `crates/*/napi` 包的 debug 增量构建和 main/preload 构建，全部成功后启动 Electron；任一步失败时不启动 Electron，等待下次 `rs`。Vite 保持运行，实际监听地址通过环境变量传给 Electron。没有运行实例时，`rs` 只更新文件，不启动应用。

## 检查与构建

| 命令 | 行为 |
| --- | --- |
| `just` | 列出快捷入口 |
| `just prepare` | 使用 frozen lockfile 安装 pnpm 依赖 |
| `just gen` | 生成 contracts；后续其他生成任务统一加入此入口 |
| `just fmt` | Biome 格式化及安全修复、cargo fmt、go fmt；会修改文件 |
| `just check` | 契约生成漂移检查、Biome、分环境 tsgo 类型检查、Rust 格式、Gateway 默认核心与原生业务包 cargo check、Go 格式与 vet；不修改源码或暂存区 |
| `pnpm gateway:test-native` | 构建两个测试 feature addon，验证 Gateway 原生双向通信与关闭，结束时恢复正常原生产物 |
| `just test` | 运行 Rust、Node 原生绑定、三语言契约 codec 与 Go 测试（须先构建原生模块） |
| `just build` | 先构建本机 napi 模块，再构建 Electron 与 Go 二进制 |

根 `tsconfig.base.json` 维护共享严格选项；桌面的 `tsconfig.node.json` 与 `tsconfig.web.json` 由 tsgo 分别检查 Node 和浏览器环境。根 `biome.json` 启用 Tailwind 指令解析。代码显示宽度不超过 120；格式工具之外仍需核对含全角字符的行。

Go 测试保护健康检查路由和方法边界；桌面通过真实 Electron 冒烟测试验证。

以下冒烟验证会启动应用，仅由用户执行：

```sh
just test
pnpm build
pnpm --dir desktop smoke
```

冒烟脚本启动独立测试进程，加载构建后的页面，验证 Node 隔离、页面挂载和 Logo 加载，保存浅色与深色截图到忽略的 `desktop/out/smoke/`，然后退出。测试同工作区时应先关闭该工作区开发实例，避免单实例锁阻止测试启动。

验证开发服务器路径可运行：

```sh
pnpm --dir desktop exec electron-vite dev --entry tests/e2e/smoke.mjs
```

## 进程与资源边界

所有工作区通过 `just start` 共用一个开发实例入口，PID 文件与旧 `xiaowei-next` 共用。切换工作区启动时会停止旧实例；启动脚本退出时清理自己拥有的进程树。正常停止先通知开发控制进程走 graceful shutdown；超时后才冻结残留进程树并逐层清理，避免监控器在兜底清理期间重新拉起应用。仅当 PID 文件仍指向自己时删除文件。冷启动由用户操作；Agent 必须先确认当前工作区有活实例，才能执行 `just rs`。

应用标识是 `com.tctony.xiaowei`，在 `desktop/electron-builder.json` 中用于打包。开发与打包统一使用系统应用数据目录下的 `com.tctony.xiaowei/` 作为 userData，不按工作区或 tag 隔离。Electron 单实例锁作用于同一个 userData；跨工作区停止旧实例由 `just start` 的全局 PID 流程负责。

Rust 搜索模块通过 napi 在 Electron 主进程加载；当前没有 sidecar。关闭 Launcher 会隐藏窗口，Cmd+Q 退出应用。

Renderer 启用 sandbox 和 context isolation，关闭 Node integration；preload 暴露隐藏、搜索、结果执行、图标获取和结果数量驱动的窗口尺寸接口；主进程校验发送方窗口及主 frame。动作仅接受当前搜索结果的 token 和 ID，实际路径／URL 由主进程回查，URL 仅允许 HTTP(S) 及内置系统设置 scheme。窗口拒绝外部导航、新窗口及 webview 嵌入。生产 HTML 不允许内联脚本；开发模式只为 React HMR 增加内联脚本许可。

## 本地打包与部署示例

在 `just build` 后生成本机目录包：

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir desktop package
```

macOS arm64 产物位于 `desktop/dist/mac-arm64/XiaoWei.app`，打包器从原始 PNG 派生应用图标。此命令用于不使用个人签名身份的本地验证，不包含正式签名、公证或上传发布。Windows/Linux 尚未验证。

Go 构建结果在 `server/bin/xiaowei-server`。部署示例：

```sh
docker compose -f deploy/compose.yaml up --build
```

Compose 仅对宿主机 `127.0.0.1:8080` 暴露端口，容器内部监听 `0.0.0.0:8080`。镜像多阶段构建，不带 Node、数据库或业务凭据。当前环境没有 Docker，容器构建和运行尚未验证。

`just prepare` 使用 `.prepare-ts` 记录上次成功安装时间。锁文件、工作区配置及根、desktop、contracts/ts、gateway/ts、packages 和 `crates/*/napi` 下的包清单都不比该时间新，且依赖安装记录与 Hook 入口存在时跳过安装；否则执行 frozen install，成功后更新时间戳。删除 `.prepare-ts` 可强制重新安装。时间戳文件不提交。

窗口首次加载被刷新或关闭取消时，忽略 Electron 的 `ERR_ABORTED`，不将其当作启动失败退出；其他加载错误仍向上传递。

## UI 组件预览

`just storybook` 启动独立组件预览，不需要 Electron 或服务端。组件场景、设计变量和验收流程见 [UI 对齐与 Storybook](ui-alignment.md)。

Rust 使用 Cargo.lock 固定依赖，本机验证工具链为 rustc 1.92.0。`just start` 和已有实例的 `just rs` 都会自动构建所有 napi 包，Cargo 负责增量编译；无实例时须单独构建原生模块，`just rs` 不会冷启动。单独安装依赖不会编译 Rust。

本地剪贴板在 main 就绪后打开 `userData/xiaowei/clipboard/history.sqlite`，macOS 启动 500ms 监听，退出时停止。原生构建入口为 `pnpm --filter xiaowei-clipboard build:debug`；renderer 使用 `getClipboard()` 的 typed client 获取分页历史、详情、图片、复制、收藏和删除，并订阅 ClipboardChanged 后重新查询。搜索「剪贴板 / clipboard」进入基础面板，Esc／空输入 Backspace 回到全局搜索；设置、同步、图片理解及其他后续范围见 [本地剪贴板 record](../.agent/records/active/2026-09-17-migrate-local-clipboard.md)。

Launcher 内置命令目前提供 macOS「切换系统主题」和开发态 `rs`（别名 reload/rebuild）；后者只 touch 当前工作区 `.rs`。正式包不提供 `rs`。其余命令及任务搜索暂不接入，范围见 [全局搜索 record](../.agent/records/active/2026-09-16-migrate-search.md)。

桌面日志同时输出 console 和 `userData/xiaowei/logs/YYYY-MM-DD-xiaowei.log`：main、renderer 和 Rust 统一写入，日期使用本地时间。当天超过 20 MiB 后，下次写入前轮转为带 `HH-mm-ss-SSS` 时间后缀的文件，重名追加序号；保留最近 15 个自然日（含今天），启动及跨天写入时清理更早的日志，不上传。调用方式与边界见 [桌面日志模块](../.agent/records/active/2026-09-17-add-desktop-logging.md)。

## 应用数据目录

应用自建的数据统一放在 `userData/xiaowei/` 下，目前包含 `clipboard/`、`logs/` 和 `cache/app-icons/`（一周有效的应用图标 PNG 缓存），与 userData 根目录的 Electron／Chromium 数据区分。开发阶段此次调整不提供运行时迁移；现有目录在应用停止后一次性移动，不能在 SQLite 打开时移动目录。

持久目录集中定义在 `desktop/src/main/paths.ts`：`createPaths` 根据 Electron 提供的系统应用数据目录生成 `userData`、`appData`（`userData/xiaowei`）、`logs`、`clipboard` 和 `appIcons`。main 入口设置 userData 后，将业务目录传给日志、剪贴板及搜索模块；业务接入层不自行拼接应用根路径。Rust 接收剪贴板目录，负责内部 `history.sqlite`、`images/` 等路径，并通过接口返回需要使用的完整路径，不复制 TS 的平台目录规则。临时外部查看文件仍由其适配层按原有生命周期管理。

## 桌面 Gateway 通信

搜索、剪贴板及窗口操作使用 `contracts/proto/xiaowei/` 生成的契约，经 `gateway/ts` 的 Electron 适配和两个既有 napi 模块的业务 endpoint 调用。renderer 仅保留 `window.gateway`，各 service 通过 `services.ts` 的 lazy getter 绑定并缓存；业务组件直接使用契约消息调用，不再保留旧 facade。接口、生命周期及验证入口见 [Gateway](../gateway/README.md#electron-与业务接入)。

桌面 check 直接检查 Gateway 源码类型；桌面 Vite（包括 main/preload 的 SSR）、Storybook 和验收资源构建通过 `source` 条件加载 Gateway 源码，不再预构建 dist。因此无改动的 `r` 不会因重写 Gateway 产物触发 renderer HMR；真实 Gateway 源码修改仍可触发 renderer HMR。默认 Node 消费仍使用 dist，并需独立构建。electron-vite 内联 Gateway／契约代码，原生模块仍外置。修改 Rust 后对已有桌面实例执行 `just rs`，共用构建入口会先更新 napi 产物，再启动 Electron。

开发态 HTML 的 CSP 额外允许 `worker-src 'self' blob:`，供 Vite 在 HMR 连接断开后创建 SharedWorker 等待服务恢复，避免停止／重启时产生 CSP 错误。该设置仅由 `apply: "serve"` 的插件注入，正式构建不添加此权限。
