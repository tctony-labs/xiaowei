---
name: inspect-desktop-logs
description: >-
  查询 XiaoWei 桌面日志，按时间、级别和 main、renderer、Rust 来源定位运行问题。
  用户要求查日志，或排查桌面运行异常需要日志证据时使用；不用于 Go 服务端日志。
---

# 查询桌面日志

## 定位文件

日志目录由 `desktop/src/main/app/paths.ts` 集中定义，通过 `desktop/src/main/app/bootstrap.ts` 传给日志模块，目前 macOS 为：

```bash
log_dir="$HOME/Library/Application Support/com.tctony.xiaowei/xiaowei/logs"
log_day=$(date +%F)
rg --files "$log_dir" -g "${log_day}-xiaowei*.log"
```

在同一 shell 中执行后续命令，或重新设置这两个变量。查询历史问题时，把 `log_day` 换成发生日期。其他平台按 `app.getPath("appData")/com.tctony.xiaowei/xiaowei/logs` 定位，不套用 macOS 路径。

- 当天活动文件：`YYYY-MM-DD-xiaowei.log`。
- 当天轮转备份：`YYYY-MM-DD-xiaowei-HH-mm-ss-SSS.log`，重名时带额外序号。
- 查询整天时必须包含备份；只读活动文件可能漏掉轮转前的错误。
- 日期和行内时间均为本地时间。保留含今天在内的 15 个自然日，更早的日志可能已清理。
- 日志属于 App，不按工作区或开发／打包隔离。不能凭日志路径判断正在运行的是哪个工作区。

## 按问题缩小范围

先按用户提供的时间和症状查询；未给时间时先看今天活动文件末尾，不先倾倒整个目录。

```bash
# 最近记录
tail -n 100 "$log_dir/$log_day-xiaowei.log"

# 当天错误与警告，兼容级别左侧补空格，保留多行错误堆栈上下文
rg -n -C 4 '\[ *(error|warn)\]' "$log_dir" -g "${log_day}-xiaowei*.log"

# 按来源筛选；将模式换成需要的来源或具体 Rust target
rg -n -C 3 '\[renderer\]|\[rust:xw_bookmark::store\]' "$log_dir" -g "${log_day}-xiaowei*.log"

# 按症状查询，使用实际错误片段替换关键词
rg -n -C 5 -F 'Application startup failed' "$log_dir" -g "${log_day}-xiaowei*.log"
```

`rg` 返回 1 只表示没有匹配。结合行内时间重建事件顺序，不把文件名排序或搜索输出顺序当作完整时间线；错误堆栈、对象可能占多行。给结论时附文件名、行号、时间和必要片段，区分直接证据与推断，避免复制无关个人数据。

需要短时观察新日志时可用 `tail -F` 跟踪活动文件，观察结束后停止；它能跟随同名文件轮转，但跨天后须重新选择当天文件。不要无限等待日志。

## 没有日志或缺少某一来源

- 文件不存在时先检查目录中有哪些日期和文件，不创建占位日志。旧版 `xiaowei.log` 或 `.dev` 目录仅在明确追查旧运行记录时查看，不能当作当前日志路径。
- `[main]` 是主进程；`[renderer]` 来自窗口的 `console-message`；Rust 带 `[main] [rust:target]`。renderer 在 DevTools、终端和文件出现同一条消息是预期的多端输出，不等于业务执行了多次。
- main 日志初始化前的失败可能只在启动终端；renderer 复杂对象在文件中可能只剩 Chromium 格式化文本；正式包不记录 debug。
- 缺少 Rust 日志时检查 `crates/xw-napi-log/src/lib.rs` 的 target 过滤，以及对应搜索／剪贴板 napi 包的 `src/logging.rs` 和 `initializeLogging` 接入。两个动态库需分别初始化；共享接收器修改后两者都要重新构建。确认新的 `.node` 已构建且实例已重启；有界异步回调在退出或队列满时可能丢日志，不能把缺日志当作未执行的证明。
- 文件输出和窗口采集入口在 `desktop/src/main/app/logging.ts`。查日志本身不清空、删除或改写日志，不为查看日志启动 App；需要构建或重启时遵循根 `AGENTS.md` 的原生模块和运行实例规则。

轮转、保留策略与日志链路的完整说明见 [桌面日志 record](../../records/active/2026-09-17-add-desktop-logging.md)。
