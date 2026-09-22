# 桌面日志模块

## Why

桌面日志目前只输出 console，退出后无法排查；Rust 依赖中的 `log` 调用尚未接入接收器。

## What

main、renderer 和 Rust 同时输出 console 与同一日志文件，保留来源标记。暂不上传日志，不做日志查看界面；Go 服务端日志不属于本轮范围。

## How

使用 electron-log 的 Node 接口管理输出，不启用其自动 IPC 或远程传输。主进程统一写文件，renderer 通过当前窗口的 `console-message` 事件采集，保留 DevTools console 并镜像到终端。renderer 不获得文件系统权限，也无需新增通用 IPC。

日志位于 `app.getPath("userData")/xiaowei/logs/`，不按工作区或 tag 隔离。开发与打包使用同一个 `com.tctony.xiaowei` 应用标识和 userData 目录。main 与 renderer 的 logger 在同一个主进程中共享 electron-log 的文件注册表，统一追加写入。

按本地日期写入 `YYYY-MM-DD-xiaowei.log`，跨天后第一条日志自动切换文件。当天文件超过 20 MiB 后，在下一次写入前重命名为 `YYYY-MM-DD-xiaowei-HH-mm-ss-SSS.log`，时间取轮转时的本地时分秒和毫秒；若重名，追加 `-1`、`-2` 等序号，不覆盖已有备份，再新建当天文件继续写入。大小阈值不是硬上限，单条日志可能使文件超出阈值。

保留今天及此前 14 个本地自然日的日志；启动以及日期变化后的第一次写入时，按文件名日期清理更早的当天文件和轮转备份。只清理匹配上述命名格式的普通文件，不处理目录、符号链接或其他文件；旧版无日期的日志保留原样。清理失败输出到原始 console，不递归写日志。

日志级别按 5 字符宽度左侧补空格，例如 `[ info]`、`[ warn]`、`[error]`。终端整条日志（包括正文、对象和多行错误堆栈）按级别着色：debug、verbose、silly 灰色，info 终端默认色，warn 黄色、error 红色；自动检测 TTY，重定向时不加颜色，文件保持纯文本。renderer 的 DevTools console 继续使用浏览器自身的级别样式。

终端输出使用独立的 Node `Console({ ignoreErrors: true })`，保留 electron-log 的格式化与级别映射。异常日志仍尝试写 console；stdout/stderr 同步或异步写入失败时忽略该输出错误，不再次触发未捕获异常或记录派生错误，文件日志继续正常写入。日志清理失败的兜底报告也使用该 Console，避免回到日志链路。

文件同步写入，记录时间、级别和来源。开发态记录 debug 及以上，正式包记录 info 及以上；renderer 的 DevTools console 保留浏览器原生行为。

调用方式：main 和 renderer 使用 `console.debug/info/warn/error`；main 初始化时接管 console，renderer 保留浏览器 console。Rust 使用 `log::debug!/info!/warn!/error!`，接收器仅转发 `xiaowei_`、`xw_` 开头的 target。main 在业务初始化前分别调用搜索和剪贴板 napi 包的 `initializeLogging` 安装接收器，初始化日志包含业务模块名称：`Native logging initialized: xiaowei-search` / `xiaowei-clipboard`。文件输出位于 `desktop/src/main/logging.ts`，共享 Rust 日志接收器位于 `crates/xw-napi-log/src/lib.rs`，两个 napi 包各自保留线程安全回调适配。

Rust 继续使用 `log` facade，当前在搜索 napi 入口安装接收器，通过有界、非阻塞、弱引用的线程安全回调转发给 main。回调不阻止进程退出，退出或队列满时不能保证尚未传递的日志落盘；主进程已收到的日志同步写入。后续独立 `.node` 模块须分别安装其日志接收器，不能假设跨动态库共享 Rust 全局 logger。

main 捕获现有 console 调用及未捕获异常监测事件；renderer 捕获 console、未处理 Promise 拒绝和渲染进程异常退出。浏览器 console-message 提供的是文本，复杂对象的文件表示受 Chromium 格式限制，需要完整结构时显式序列化。业务日志不主动记录搜索词、剪贴板正文或密钥；调用者仍需避免输出敏感内容。

剪贴板页面分别以 `Clipboard refresh failed` 和 `Clipboard subscription failed` 记录读取与订阅异常，使用 JSON 字符串保留 Gateway 错误码、异常堆栈和耗时。读取日志包含分类／列表阶段、分页偏移、视图、搜索词长度和请求是否已过期；订阅日志包含事件名及页面 effect 是否仍有效。不主动附加搜索词、剪贴板正文或文件路径。日志覆盖已过期请求的失败，页面原有错误提示及重试行为保持不变。

### 源码位置（方案 A）

自有 TS/TSX 源码继续使用 `console.log/info/warn/error/debug/trace(...)`。`packages/source-log/vite.ts` 在 Vite 的 pre transform 阶段用 Babel 解析原始源码和作用域，通过 magic-string 改写直接调用并生成 source map。处理进入该 Vite 构建链的整个工作区 JS/TS/JSX/TSX 源码（包括 `packages/`、`contracts/ts/` 等跨包源码），排除工作区外文件、node_modules、dist/out/target/coverage/storybook-static/.git/.vite 目录、日志包装器和局部声明／导入的同名 console；解构、别名、计算属性、可选调用和 `globalThis.console` 不注入，当前业务源码没有这些调用方式。main、preload、renderer 和独立 `scripts/dev/build-desktop-main.mjs` 共用配置；Storybook 不启用此插件。插件和无平台依赖的 runtime 位于共享包 `@xiaowei/source-log`，Vite/Babel 共用路径与调用筛选规则；未经过该构建链的独立 Node 脚本、tsc 任务和 external/prebundle 包不自动注入，独立 Vite 构建需显式接入插件。

位置格式为 `[desktop/src/main/index.ts:行号]` 或 `[packages/utils/src/index.ts:行号]`，文件路径相对工作区根目录、使用 `/`。调用参数仍交给原 console；首参数为字符串时将位置合并到格式字符串前，保留 `%s`、`%o`、`%c` 等占位符及其参数，其他首参数保持原对象／Error 引用。DevTools 同样显示源码位置前缀，其原生可点击链接仍可能指向包装器或产物。无运行时抓栈或源码映射。

renderer/preload 沿用唯一的 `console-message` 通道：有注入位置前缀时直接记录，不追加产物 URL 和行号；其他消息继续使用 Electron 提供的位置兜底。不另建 IPC 通道，避免双通道去重和对象序列化协议；复杂对象仍受现有 Chromium 文本格式限制。未注入日志内容若自行以同样的源码位置前缀开头，也会被视为已有位置。

插件默认开启。启动或构建前设置 `XIAOWEI_LOG_SOURCE=0` 关闭，改变开关后需重启 Vite；例如 `XIAOWEI_LOG_SOURCE=0 pnpm --filter @xiaowei/desktop build`。关闭后不改写业务调用、不引入包装器调用，也不自动抓栈；main 省略位置，renderer 保留 Electron 提供的脚本位置。仅关闭 TS 插件，不影响 native 源码位置。

native 接收器保留 target 用于 `xw_` / `xiaowei_` 过滤，额外将可选 `file`、`line` 透传到两个 napi 包。main 输出 `[crates/xw-bookmark/src/store.rs:行号]`，不再打印重复的语言或 target；缺少 file 时省略位置。`scripts/dev/build-napi.mjs` 为两个包的 debug/release 构建统一追加 `--remap-path-prefix=<工作区>=.`，保留已有 Rust 编译参数；接收器去掉 `./` 并统一分隔符。工作区外的源码位置不匹配该映射，保留原值。首次引入或改变编译参数会触发 Cargo 重编译；直接绕过 npm 构建入口运行 Cargo 不应用该映射。

React Native 使用 Metro，不能直接加载 Vite 插件。共享包另提供 `@xiaowei/source-log/babel` 入口，由宿主 Babel 解析和生成代码；沿用原有 RN/Expo preset，在源码转换阶段注入位置。默认根目录为当前工作区，可用 `workspaceRoot` 指定绝对路径；通过 `enabled: false` 或环境变量关闭。修改开关后需重启 Metro 并清理转换缓存。插件不依赖 Electron、不安装 Metro、不改变移动端日志传输和落盘。接入示例及 Metro 对工作区源码的可见性要求见 [共享日志定位包](../../../packages/source-log/README.md)。

性能对比入口：`node scripts/benchmark-log-source.mjs`。交替开关各三次，构建三个目标到临时目录，并使用 Vite middleware 模式验证 renderer 转换后的位置与失效重转换；不启动 Electron。关闭依赖预打包，保留 OS／依赖缓存，记录的开发转换时间不等于完整应用冷启动或浏览器 HMR 耗时。

## Outcome

2026-09-22 补齐剪贴板页面读取和事件订阅的失败日志，保留原始异常及请求上下文，供“复制文件夹后打开页面报错、重载后恢复”的后续观察使用；本次未确认该偶发异常的根因。桌面类型检查、修改文件的 Biome 检查和 Gateway 异常序列化验证通过，实际故障日志待再次发生时验证。

2026-09-21 终端染色覆盖整条日志，在最终格式化后按 level 包裹颜色并在末尾重置。10 项日志测试、桌面类型检查和修改文件的 Biome 检查通过，覆盖正文、对象、错误堆栈、颜色开关及文件纯文本输出。

2026-09-20 范围修正与 RN 适配：取消 desktop 源码目录限制，共享包覆盖工作区源码；renderer 位置识别同步支持跨包路径。新增 Vite 实际跨包构建开关测试，以及 Babel TSX、作用域过滤、路径排除、嵌套调用与运行输出测试。`just check`、24 项桌面测试、3 项共享包 Babel 测试和桌面正式构建通过。React Native/Metro 尚无项目，未声称已完成真机或 Fast Refresh 验收。

2026-09-20 源码定位：`just check`、`just test`（包含 22 项桌面测试和 8 项 napi 测试）及桌面正式构建通过，两个 native debug 包已重建，回调验证得到工作区相对路径与有效行号。插件开关均通过实际 Vite production/dev 转换验证，测试覆盖 TSX、行号更新、局部 console、指令保留、嵌套调用、格式参数和 renderer 单次写入／不追加产物位置。尚未完成当前工作区 Electron 的端到端验收：现有运行实例属于主工作区，未重启或冷启动。

同进程交替三轮测量：全量构建中位数关闭 417ms、开启 434ms；开发模块失效重转换各轮均值关闭 5.8–7.8ms、开启 5.6–6.5ms。首次冷转换受缓存影响明显（首轮 42ms，后续约 4–5ms），不足以据此判断完整冷启动差异；未观察到稳定的重转换退化，不代表更大项目或实际浏览器 HMR 零成本。

修复退出时 console 写入 `EIO` 经未捕获异常监测反复记录、导致日志持续轮转的问题。新增独立 Node 子进程测试覆盖正常终端、同步 `EPIPE` 和异步 `EIO`，验证异常仍尝试输出 console、无派生未捕获异常及重复日志、后续文件写入继续；14 项桌面测试、桌面类型检查和修改文件的 Biome 检查通过。未启动桌面实例，实际终端关闭时的 Electron 退出行为待运行验证。

初始化日志已增加搜索与剪贴板业务模块名称；两个 napi debug 包重建成功，8 项 napi 测试通过（包含模块名称与独立回调验证），确认当前工作区实例归属后已执行 `just rs`。

查询日志的可复用流程已登记为 [inspect-desktop-logs](../../skills/inspect-desktop-logs/SKILL.md)，覆盖文件定位、备份查询、按来源和错误筛选，以及缺失日志的排查边界。

已实现按天统一文件与 console 输出、20 MiB 时间命名轮转和 15 天清理、级别过滤、renderer 采集及 Rust napi 回调。`just check`、`just test`（63 项 Rust、4 项 napi、3 项桌面日志测试及 Go 测试）通过，napi debug 与桌面生产构建通过。日志测试验证了来源标记与统一写入、console 输出、错误记录、轮转时间命名及同毫秒防覆盖、跨天切换、15 天清理边界与生产级别过滤；napi 测试验证了回调投递和重复初始化。

确认当前工作区 Electron 与开发监听进程的 cwd、绝对路径和父子关系后执行 `just rs`，初版验证了 main 和 renderer 各自落盘；统一文件后进一步验证共同写入及交替触发轮转；按天方案测试确认保留各次轮转备份，不再覆盖上一份。未冷启动新的开发实例，未添加日志上传。

## 后续工作

- 日志上传：后续单独设计和实现，本轮仅提供本地 console 与文件输出。

测试目录整理：原 desktop 的 source-location 测试迁入共享包，拆为 test/vite.test.mjs 和 test/runtime.test.mjs，与既有 Babel 测试统一；应用日志测试位于 desktop/tests/logging.test.mjs。8 项共享包测试及应用日志回归通过，根 scripts/benchmark-log-source.mjs 完整执行通过。
