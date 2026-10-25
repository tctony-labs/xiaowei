# 运行实例检查入口

Electron main 通过 `services/inspect/` 提供当前代码来源的本地 Unix socket。配套 Rust CLI 位于 [`desktop/inspect/`](../inspect/README.md)，支持工作区开发实例和 macOS 正式包；隐藏窗口也可查询，状态读取不激活窗口。

## 宿主接入

`app/bootstrap.ts` 传入现有工作区或 App bundle 来源，在 Launcher 和快捷键初始化后挂载 listener，并在原有关闭流程中先关闭外部入口。入口初始化失败只记录错误。开发启动、重启、单实例锁、用户数据目录、Agent／模型配置和数据共享关系保持现状。

`services/inspect/protocol.ts` 放服务内部的协议常量、消息类型和宿主方法声明，由同目录模块及测试引用，不属于 main／renderer 共用的 `src/shared/`。`target.ts` 解析规范来源和 runtime socket；`server.ts` 负责权限、帧、来源与参数校验、期限、写操作排序和关闭；`host.ts` 将白名单方法接到现有 owner。完整协议和唯一的来源哈希规则见 [本地协议](../inspect/docs/protocol.md)。

## 状态与动作

- `windows/snapshots.ts` 读取 BrowserWindow 的实际显隐、焦点、置顶、位置及 renderer 加载状态；Launcher 和设置 owner 只提供窗口归属。
- Launcher 的显式显示入口等待焦点交接，并为原生显示与聚焦提供最多一秒的状态确认；期间关闭、收起或切换到其他模式即停止等待，不重复激活。重复显示保持可见。隐藏入口复用原焦点归还流程，返回实际归还结果；窗口已经隐藏时不再执行归还。
- focus session 只读快照不重新 capture；Dock owner 区分实际可见、预期可见、弹层导致的延后与系统重试。
- 快捷键 owner 报告配置与 registry 的实际系统注册，区分菜单暂停和不可用，不改变原注册／恢复策略。

检查服务不持有另一份业务数据或窗口状态。操作完成后仍应检查返回值；Dock 等异步结果可有期限地复查。视觉、文字和输入法仍需 UI 验收。

## 使用与验证

调用命令和二进制位置见 [CLI README](../inspect/README.md)。仓库 Agent 使用 [inspect-running-app](../../.agent/skills/inspect-running-app/SKILL.md)，进程归属、日志和已有实例重载使用 [manage-dev-instances](../../.agent/skills/manage-dev-instances/SKILL.md)。

自动回归位于 `tests/inspect-*.test.mjs` 及 `inspect/tests/`：真实 Rust 客户端与 TS listener 通信，验证来源、方法、权限、期限、关闭、App 路径和符号链接。窗口、焦点、Dock 和快捷键回归使用既有 owner 测试。测试 fixture 不创建 Electron 实例，也不接触共享业务数据。
