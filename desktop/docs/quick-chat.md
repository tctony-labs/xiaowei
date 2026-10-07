# Quick Chat 入口与窗口交互

本文维护 desktop 包内的 Quick Chat 入口、窗口协调、键盘、会话展示、模型选择和设置导航，依据当前实现与 [Agent Chat](../../.agent/records/active/2026-09-28-agent-chat.md) 的交付范围维护。Launcher 搜索与跨包调用链见 [搜索实现](../../docs/search.md)，迁移背景与历史验收见 [Quick Chat record](../../.agent/records/archived/2026-09-24-quick-chat-ui-interaction.md)。

## 产品入口与窗口交互

- 空搜索输入（含纯空格）按 ↓ 展开；非空 ↑↓ 继续导航搜索结果。聊天 Esc 收起；只有编辑目标内且输入 trim 为空时，↑ 才收起。输入法合成及 keyCode 229 不切换模式。
- Modal、标题栏菜单、重命名和模型菜单先处理自己的 Esc；关闭后下一次才收起聊天。Enter 发送，Shift+Enter 换行，IME 合成不发送。
- 搜索高度 71px，聊天高度 580px，滑轨 300ms ease-out。从搜索展开先原生扩高，收起等待动画后恢复搜索高度及焦点；反向切换清理旧计时器，过渡中锁定消息滚动。
- 从剪贴板进入聊天直接以展开状态挂载，不重放搜索动画；聊天状态下搜索结果不能缩小窗口。主快捷键只切窗口显隐，快速对话快捷键遵循同模式显隐／跨模式切换，重新显示聚焦当前输入。默认值与自定义规则见 [快捷键](../../docs/shortcuts.md)。
- 进入或离开剪贴板模式时清空搜索；搜索与聊天之间切换不统一清空搜索。聊天草稿与消息独立保留。
- LauncherOpened 订阅在页面存活期间保持，通过 React effect event 获取最新 UI 状态，不因剪贴板模式重建订阅。隐藏、收起及模式切换不停止 Agent Run。
- QuickChatTransition 的滑轨同时约束 top／bottom，让长搜索列表内部滚动；结果选中背景即时切换，不做颜色渐变，避免滚动后的残留高亮。
- 标题栏保留原生拖动区域，按钮／菜单排除拖动；新建、会话选择和更多操作复用 QuickChatTitleBar。空白会话隐藏更多，新建空白不重复创建或清掉草稿。

## 输入、消息与会话操作

`QuickChatPanel` 只消费 props 与回调，不创建会话或连接 Gateway；`useQuickChat` 对接共享的 Agent client。客户端启动恢复最后更新的未归档会话，没有历史时保留空白对话。草稿、错误反馈及消息滚动位置按会话在 renderer 内存中隔离，刷新后不恢复；消息及会话配置由 Agent 持久化。

- 输入使用 textarea，随内容从 21px 增长至 105px，外层输入区至少 65px。发送要求模型已配置、输入 trim 非空，且不在生成、加载或配置保存中；生成期间按钮改为停止。
- 发送成功只清除仍与提交内容相同的草稿，不清掉等待期间的新输入。失败保留输入，不自动重发。Cmd/Ctrl+N 与标题栏按钮共用新建操作；已有运行先停止并等待结算，已有历史保留；已经是空白且无运行时不重复新建或清空草稿。
- 消息正文保留换行并按纯文本展示，思考可折叠；展示等待、停止、消息错误、页面错误及模型查询警告。标题优先使用会话标题，其次首条用户消息，最后回退为“新的对话”。
- 用户接近消息底部时跟随流式输出，向上浏览后保留位置；切换会话恢复各自的滚动位置与跟随状态，发送时恢复跟随。
- 标题栏提供新建、未归档会话列表与分页选择，以及重命名、更新标题、归档、复制 Session ID、删除确认；这些产品回调已连接真实 Agent／系统接口。没有消息时隐藏更多菜单；没有会话或助手回复、聊天生成中或标题生成中，不允许更新标题。当前不展示 workspace、授权路径或会话详情入口。
- 切换会话不停止旧会话运行；隐藏、收起或取消 UI 观察也不等于停止 Run。只有聊天展开且 document 可见时持有独立的查看保护流，隐藏、最小化、切换或离开聊天时释放，供自动维护判断。

会话管理、运行结算、标题及维护的领域语义统一见 [Agent 运行与 UI](../../.agent/records/active/2026-09-28-agent-chat/runtime-ui.md)，这里仅描述 desktop 的接入与展示。

## 模型与思考选择

空白对话的初始选择由 `useQuickChat` 根据 ModelSettings 快照计算：全局默认引用能在提供方模型列表中找到时使用它，否则取第一个没有 `unavailableReason` 且含模型的提供方的首个模型。已有会话优先使用其保存的配置，空白对话的手动选择暂存于 hook；模型查询失败不替换已有会话的模型引用，而是显示提示。这些选择规则不表示模型已通过真实生成验证。

模型与思考 chip 位于输入区外、其上方的右侧，菜单通过 portal 向上展开。空白对话修改本地选择；已有会话调用 SetSessionConfig，保存期间禁用选择与发送。换模型时只保留新模型支持的思考强度，否则清除覆盖值；当前已保存的强度不在能力列表中时仍展示其选项。Run 的配置快照与持久化语义见 [Agent Host](../../.agent/records/active/2026-09-28-agent-chat/host-interface.md#composer-模型与思考强度切换)。

模型快照先订阅变更再读取初值，并用 revision 与事件到达情况拒绝旧快照覆盖。模型配置加载失败、应用失败或凭据不可用时显示对应错误；已有会话仍可使用其保存的引用发送，由实际调用返回结果。

## 模型空态与设置导航

模型快照存在、没有可选初始模型且没有配置加载／应用错误时，以灰色图标和普通文字显示“暂无可用模型”。该引导可出现在已有消息之后，不只用于空白会话；不替代真实生成失败提示。

“设置 - 模型”调用 System.OpenSettings(anchor=MODEL_PROVIDERS)。窗口控制器复用／创建设置窗口并隐藏 Launcher；目标保留至有效页面调用 TakeSettingsNavigation 原子消费。SettingsNavigationRequested 只是定向通知，订阅取消不丢掉目标，避免 StrictMode 首次 effect 清理的竞态。模型快照加载后滚动到提供方配置区域（含添加按钮），主色描边高亮 1.6 秒；重复导航重计时，手动切页清除。打开失败在引导下提示并可重试，不写导航目标到持久设置。

## 预览与产品边界

组件位于 [src/renderer/src/components/quick-chat/](../src/renderer/src/components/quick-chat/)。QuickChatTransition 管视口／滑轨，QuickChatTitleBar 接收 props／回调；QuickChatLauncherPreview 与 QuickChatChatPreview 仅由 Storybook／测试消费，不连接真实会话或模型。产品复用同一展示组件，输入使用 textarea，正文保留换行以纯文本展示，思考内容可折叠。Markdown／代码块等后续展示能力及其验收在 Agent Chat 中推进；预览 mock 不代表工具、权限或持久能力交付。

## 实现与验证入口

- [Launcher.tsx](../src/renderer/src/components/Launcher.tsx)：模式入口、原生布局协调与稳定订阅。
- [QuickChatTransition.tsx](../src/renderer/src/components/quick-chat/QuickChatTransition.tsx)：滑轨、窗口尺寸与搜索视口。
- [QuickChatPanel.tsx](../src/renderer/src/components/quick-chat/QuickChatPanel.tsx)：产品输入与键盘优先级。
- [QuickChatTitleBar.tsx](../src/renderer/src/components/quick-chat/QuickChatTitleBar.tsx)：标题栏与菜单展示。
- [use-quick-chat.ts](../src/renderer/src/components/quick-chat/use-quick-chat.ts)：Agent 页面适配。

相关组件与 hook 测试与实现并排放置，统一入口见 [桌面测试](../tests/README.md)。预览使用模拟服务，不能代替原生窗口、系统剪贴板或真实 Agent 验收；当前运行证据和剩余复验统一见 [Agent 交付证据](../../.agent/records/active/2026-09-28-agent-chat/implementation-results.md#验收限制与后续工作)。
