# 查询快捷键并唤起窗口

## 读取当前实例配置

1. 先确认运行实例属于目标工作区。已有可信 Gateway 调用入口时，可用 `xiaowei.desktop.settings.Settings.Get` 读取有效 `shortcuts`；不要为查询新增调试 RPC、启用远程调试或启动另一个实例。
2. 没有现成调用入口时，只读查询该实例实际使用的 Storage 数据库。路径由 [paths.ts](../../../../desktop/src/main/app/paths.ts) 决定，必要时结合进程打开文件确认。普通 macOS 实例为 `~/Library/Application Support/com.tctony.xiaowei/xiaowei/storage.sqlite`，本地更新测试实例使用另一目录；`XIAOWEI_AGENT_HOME` 只影响 Agent 数据，不决定此数据库位置。不存在时报告，不创建数据库。

```sql
SELECT value FROM meta WHERE key = 'setting.shortcuts';
```

Python 查询时使用 `sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)`，避免误建或写入数据库。只读取上述设置键，不倾倒其他设置或用户数据。

保存值是 JSON 对象，`quickChat` 和 `main` 分别保存键名数组或 null，例如 `{"quickChat":["Meta","Alt","KeyQ"],"main":["Meta","Space"]}`。它是原始覆盖值，有效设置的合并与校验以 [settings/mod.rs](../../../../crates/xw-storage/src/settings/mod.rs) 的 `defaults`、`shortcuts_from_json` 和 `apply_stored` 为准：

- 没有保存记录时，才按当前平台的源码默认值确定绑定。macOS 默认 Quick Chat 为 `⌘⇧C`，主窗口为 `⌘Space`；不能把默认值当作用户当前配置。
- 已保存且有效的 `quickChat` 数组覆盖默认值；null 表示禁用。旧设置对象缺少 `quickChat` 时也表示 Quick Chat 快捷键未启用，不能补用默认 `⌘⇧C`。`main` 缺失时沿用其默认值，null 表示禁用。
- 非法 JSON 或无效对象可能被设置加载器忽略；不能直接把原始值视为有效绑定。遇到这种情况先按源码核对或读取有效 Settings 快照，不猜测组合键。

## 使用绑定并确认结果

按 [shortcuts.ts](../../../../desktop/src/main/services/shortcuts/shortcuts.ts) 的映射解释键名：macOS 的 `Meta` 为 Command，`Alt` 为 Option，`KeyQ` 为 Q；其他平台使用对应映射。发送组合键时保留全部修饰键。

优先使用有效的 `quickChat` 绑定。它禁用时，可用有效 `main` 绑定拉起 Launcher，再从现有 UI 进入快速对话；两者都禁用时，请用户手动显示现有窗口，不自行修改设置或重新绑定快捷键。

发送后必须确认目标窗口确实可见，并核对窗口进程归属，再连接自动化。设置已保存不保证操作系统注册成功；未唤起时查询目标实例控制台中的 `Launcher shortcut unavailable`／`Shortcut unavailable` 等信息，不反复试默认键，也不把隐藏状态的取窗失败当作自动化服务故障。
