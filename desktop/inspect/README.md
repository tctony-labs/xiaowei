# XiaoWei Inspect CLI

`xiaowei-inspect` 通过本地 Unix socket 检查配套运行实例的窗口、焦点、Dock 和快捷键，并经现有窗口入口显示／收起 Launcher。crate 与二进制同名，属于根 Cargo workspace。CLI 不启动 App，查询不会激活窗口。

## 开发

需要仓库指定的 Rust 工具链。App 由用户按既有入口启动；CLI 在工作区根目录调用，Cargo 负责增量编译和定位二进制：

```sh
just inspect --help
just inspect identify --json
just inspect capabilities --json
just inspect status --json
just inspect windows
just inspect shortcuts
just inspect show quick-chat
just inspect show search
just inspect show clipboard
just inspect hide
```

默认产物为 `<工作区>/target/debug/xiaowei-inspect`。直接调用开发二进制时需传 `--workspace /absolute/workspace`；目标以规范化的工作区路径确定，与编译时路径和调用者 cwd 无关。

## 正式 App

macOS 包内携带独立二进制，随 App 签名与更新，无需用户安装 Rust 或 Node。用实际安装位置调用：

```sh
"/Applications/XiaoWei.app/Contents/Resources/bin/xiaowei-inspect" status --json
```

也可自行将 `~/.local/bin/xiaowei-inspect` 链接到这个二进制并将该目录加入 PATH。CLI 解析真实可执行文件的位置，所以经符号链接运行仍配对所属 App。App 未运行时返回 `APP_NOT_RUNNING`；不会改连另一份安装或其他工作区。`--help` 和 `--version` 可离线使用。

## 结果

默认输出可读摘要，`--json` 输出单个 JSON 响应。成功响应的业务结果位于 `result`；本地失败返回 `ok: false` 和 `error`。退出码 `0` 表示命令完成，`1` 为运行／连接失败，`2` 为参数错误。

`show` 必须指定模式，等待 owner 完成唤起并检查实际显隐、焦点与模式；重复显示保持可见。`hide` 返回隐藏后的状态与 `focusRestored`：`true` 为已归还，`false` 为未归还，`null` 为窗口已隐藏、无需执行归还。Dock 等系统状态可能异步变化，应检查返回的实际值与 pending／deferred 状态。

CLI 只提供当前实现列出的检查与窗口操作。共享数据目录、登录态、Agent／模型配置、单实例锁和开发启动／重启方式均保持现状。

协议与定位规则见 [本地协议](docs/protocol.md)，App 侧接入见 [运行实例检查](../docs/inspect.md)。仓库 Agent 操作流程见 [inspect-running-app](../../.agent/skills/inspect-running-app/SKILL.md)。内嵌技能与 Quick Chat／其他 Agent 的产品接入留待后续。

## 验证

```sh
cargo test -p xiaowei-inspect --locked
pnpm --dir desktop exec node --test tests/inspect-*.test.mjs
```

协议集成使用真实 Rust 客户端和 TS socket listener，宿主由本地 fixture 提供，不创建 Electron 实例。
