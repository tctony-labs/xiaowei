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

日志级别按 5 字符宽度左侧补空格，例如 `[ info]`、`[ warn]`、`[error]`。终端日志前缀按级别着色：debug 灰色、info 青色、warn 黄色、error 红色；自动检测 TTY，重定向时不加颜色，文件保持纯文本。renderer 的 DevTools console 继续使用浏览器自身的级别样式。

文件同步写入，记录时间、级别和来源。开发态记录 debug 及以上，正式包记录 info 及以上；renderer 的 DevTools console 保留浏览器原生行为。

调用方式：main 和 renderer 使用 `console.debug/info/warn/error`；main 初始化时接管 console，renderer 保留浏览器 console。Rust 使用 `log::debug!/info!/warn!/error!`，接收器仅转发 `xiaowei_`、`xw_` 开头的 target。main 在业务初始化前分别调用搜索和剪贴板 napi 包的 `initializeLogging` 安装接收器。文件输出位于 `desktop/src/main/logging.ts`，共享 Rust 日志接收器位于 `crates/xw-napi-log/src/lib.rs`，两个 napi 包各自保留线程安全回调适配。

Rust 继续使用 `log` facade，当前在搜索 napi 入口安装接收器，通过有界、非阻塞、弱引用的线程安全回调转发给 main。回调不阻止进程退出，退出或队列满时不能保证尚未传递的日志落盘；主进程已收到的日志同步写入。后续独立 `.node` 模块须分别安装其日志接收器，不能假设跨动态库共享 Rust 全局 logger。

main 捕获现有 console 调用及未捕获异常监测事件；renderer 捕获 console、未处理 Promise 拒绝和渲染进程异常退出。浏览器 console-message 提供的是文本，复杂对象的文件表示受 Chromium 格式限制，需要完整结构时显式序列化。业务日志不主动记录搜索词、剪贴板正文或密钥；调用者仍需避免输出敏感内容。

## Outcome

查询日志的可复用流程已登记为 [inspect-desktop-logs](../../skills/inspect-desktop-logs/SKILL.md)，覆盖文件定位、备份查询、按来源和错误筛选，以及缺失日志的排查边界。

已实现按天统一文件与 console 输出、20 MiB 时间命名轮转和 15 天清理、级别过滤、renderer 采集及 Rust napi 回调。`just check`、`just test`（63 项 Rust、4 项 napi、3 项桌面日志测试及 Go 测试）通过，napi debug 与桌面生产构建通过。日志测试验证了来源标记与统一写入、console 输出、错误记录、轮转时间命名及同毫秒防覆盖、跨天切换、15 天清理边界与生产级别过滤；napi 测试验证了回调投递和重复初始化。

确认当前工作区 Electron 与开发监听进程的 cwd、绝对路径和父子关系后执行 `just rs`，初版验证了 main 和 renderer 各自落盘；统一文件后进一步验证共同写入及交替触发轮转；按天方案测试确认保留各次轮转备份，不再覆盖上一份。未冷启动新的开发实例，未添加日志上传。

## 后续工作

- 日志上传：后续单独设计和实现，本轮仅提供本地 console 与文件输出。
