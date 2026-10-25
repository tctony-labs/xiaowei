# xw-sandboxed-exec

为 Agent 进程生成 macOS Seatbelt 策略与 sandbox-exec 参数，不持有会话、运行或子进程。执行及取消由调用方负责；其他平台不提供无沙箱执行回退。

迁移自旧 XiaoWei `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` 的 `crates/sandboxed-exec`（原 Cargo.toml 声明 MIT）；保留原 SBPL 模板及策略生成逻辑。新增精确文件授权，避免目录 subpath 扩大文件级授权。

策略从 deny default 开始，按需要允许文件读取、网络和指定写入根。子进程继承限制；写入授权可区分目录和单文件。调用方必须解析真实路径、明确是否允许自动添加 cwd，不自动添加浏览器专用目录。

```sh
cargo test -p xw-sandboxed-exec --locked
```
