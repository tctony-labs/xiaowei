# Quick Chat 入口与窗口交互

## Why

迁移旧版 Quick Chat 时，先对齐 Launcher 入口：空搜索框按 ↓ 展开，聊天输入按 Esc 或空内容 ↑ 收起并返回搜索。旧版交互较成熟，需要同时核对动画、焦点、菜单优先级和空会话状态。

## What

提供可用的搜索／对话切换、标题栏、会话菜单、键盘和原生窗口协调，并用共享组件保留独立预览。用户已确认基础交互并要求接产品；“在外部对话窗口打开”按钮明确移除。

本事项承载入口、窗口与展示交互。初期 renderer 内存直调 LLM 已由[Agent Chat](2026-09-28-agent-chat.md)取代；Agent 的持久会话、协议、模型选择、标题和工具范围统一在该事项维护，不重复保留旧执行方案。

## How

旧版参考 `xiaowei-next` 的 `a45f5cd1ba197c76ae6b528d30f382f7080a5100`：LauncherPage／modes、QuickChatTitleBar／QuickChatComposer。核对依据为源码，不宣称完成旧版运行画面的逐像素对齐。

### 产品入口与窗口交互

- 空搜索输入（含纯空格）按 ↓ 展开；非空 ↑↓ 继续导航搜索结果。聊天 Esc 收起；只有编辑目标内且输入 trim 为空时，↑ 才收起。输入法合成及 keyCode 229 不切换模式。
- Modal、标题栏菜单、重命名和模型菜单先处理自己的 Esc；关闭后下一次才收起聊天。Enter 发送，Shift+Enter 换行，IME 合成不发送。
- 搜索高度 71px，聊天高度 580px，滑轨 300ms ease-out。从搜索展开先原生扩高，收起等待动画后恢复搜索高度及焦点；反向切换清理旧计时器，过渡中锁定消息滚动。
- 从剪贴板进入聊天直接以展开状态挂载，不重放搜索动画；聊天状态下搜索结果不能缩小窗口。Cmd+Space 只切窗口显隐，Cmd+Shift+C 遵循同模式显隐／跨模式切换，重新显示聚焦当前输入。
- LauncherOpened 订阅在页面存活期间保持，通过 React effect event 获取最新 UI 状态，不因剪贴板模式重建订阅。隐藏、收起及模式切换不停止 Agent Run。
- QuickChatTransition 的滑轨同时约束 top／bottom，让长搜索列表内部滚动；结果选中背景即时切换，不做颜色渐变，避免滚动后的残留高亮。
- 标题栏保留原生拖动区域，按钮／菜单排除拖动；新建、会话选择和更多操作复用 QuickChatTitleBar。空白会话隐藏更多，新建空白不重复创建或清掉草稿。

产品 QuickChatPanel 消费 Agent 客户端投影，草稿／滚动按会话保存在 renderer 内存；消息和会话跨重启保留。新建先停止并等当前 Run 结算但保留旧会话，普通切换不停止旧 Run；启动选最后更新的未归档会话。菜单和标题的具体行为统一见[运行与 UI](2026-09-28-agent-chat/runtime-ui.md)，模型／思考 chip 与保存语义见[Host](2026-09-28-agent-chat/host-interface.md#composer-模型与思考强度切换)。

### 模型空态与设置导航

空白会话无可用模型时，以灰色图标和普通文字显示“暂无可用模型”。初始选择使用全局默认，缺失／被删除时按可用提供方／模型顺序取首个，不写回全局默认。已有会话按自己的 model_ref／reasoning 发送，模型信息失败只给持续 hint，不自动换模型；空态不替代真实生成失败提示。

“设置 - 模型”调用 System.OpenSettings(anchor=MODEL_PROVIDERS)。窗口控制器复用／创建设置窗口并隐藏 Launcher；目标保留至有效页面调用 TakeSettingsNavigation 原子消费。SettingsNavigationRequested 只是定向通知，订阅取消不丢掉目标，避免 StrictMode 首次 effect 清理的竞态。模型快照加载后滚动到提供方配置区域（含添加按钮），主色描边高亮 1.6 秒；重复导航重计时，手动切页清除。打开失败在引导下提示并可重试，不写导航目标到持久设置。

### 预览与产品边界

组件位于 desktop/src/renderer/src/components/quick-chat。QuickChatTransition 管视口／滑轨，QuickChatTitleBar 接收 props／回调；QuickChatLauncherPreview 与 QuickChatChatPreview 仅由 Storybook／测试消费，不连接真实会话或模型。产品复用同一展示组件，输入使用 textarea，正文保留换行以纯文本展示，思考内容可折叠；Markdown 解析及代码块渲染尚未接入。预览 mock 不代表工具、权限或持久能力交付。

## Outcome

基础入口、动画、焦点、菜单及空态已接产品。用户已确认交互、模型空态／设置引导和搜索键盘滚动修复；原生快捷键卡顿修复也经实际按键确认，调度依据与结论统一见[快捷键事项](2026-09-18-fixed-launcher-shortcuts.md#原生快捷键与微任务调度)。临时采样、flushSync 尝试和调试开关均已撤回，不保留为当前设计。

组件／Launcher 回归覆盖滑轨高度、末项滚动、稳定订阅、直接展开、IME／Esc 优先级、设置导航 StrictMode、空白新建与菜单状态。相关 TS、Biome、Storybook 构建与桌面检查通过；Agent 迁移后的验证统一见[交付证据](2026-09-28-agent-chat/implementation-results.md)。

最新持久会话菜单、模型选择恢复等窗口复验限制保留在 Agent 交付证据；搜索高亮闪动、系统剪贴板复制、原生拖动及首次设置跳转的最终 Electron 复验没有完整直接证据，不宣称全部平台验收结束。此 record 留在 active 承载当前入口行为，不保留内存 MVP／已完成接线计划。
