# xw-agent-rollout

Agent 权威 JSONL 的文件层，只负责目录定位、独占写锁、串行提交、严格读取及未提交尾部修复。不调用 Host、模型、工具、Gateway 或 Storage，也不决定 Run 的业务恢复状态。

`RolloutStore::new(root)` 接收宿主传入的根目录。`create` 接收独立创建时间与模型配置，依次提交 SessionHeader 和初始 Meta，初始化失败删除未登记文件；`open` 先拿跨进程 OS 锁再读取／修复；`Journal::append` 生成稳定 entry 身份，`append_entry` 保留调用方提供的身份。记录经 types 的局部与完整历史校验，完整行、换行、flush／sync_data 成功后才推进确认位置和 sequence。compact codec 结合前缀恢复领域字段，live cache 与文件重开一致；文件锁覆盖 Journal 生命周期，锁文件不删除，不抢占其他进程。

新 journal 位于 `sessions/YYYY/MM/<id>.jsonl`，锁位于 `locks/`。正常 Ready writer 不按 query 重扫；写失败转 NeedsCheck 并拒绝追加。`check_after_failure` 保存诊断副本、回到最后确认提交的字节边界并重新校验，成功才回 Ready。冷打开只修复未提交的 EOF 尾部；未知版本／字段、完整非法行和中间损坏保留报错。业务中断结算由 xw-agent 追加，不自动重放。

生产会话按 SQLite 登记的创建时间和 ID 定位文件；`delete_registered` 直接清理自有 journal／workspace，失败清理由 xw-agent 的 SQL deleting 状态管理，不创建永久删除标记。显式非 indexed 入口仍保留独立 deletion marker API，不用于桌面持久会话。不会跟随 workspace symlink 删除外部目录。

```sh
cargo test -p xw-agent-rollout --locked
cargo clippy --no-deps -p xw-agent-rollout --all-targets --locked -- -D warnings
```

测试包括真实独立进程锁竞争／释放／强制退出、各种失败提交和尾部修复。非默认 `test-support` feature 仅供 core dev-dependency 注入文件故障，生产构建不启用。
