# Quick Chat 入口与内存对话

## Why

用户要求迁移旧版 Quick Chat 时优先核对 Launcher 入口：空搜索框按 ↓ 展开，聊天输入按 Esc 或空内容时按 ↑ 收起并返回搜索框。旧版交互已比较成熟，迁移应先在 Storybook 对齐动画、焦点、菜单优先级和空会话状态。

## What

首片交付 Storybook 中可独立操作的 Quick Chat 入口交互预览：搜索与对话切换、标题栏、模拟会话操作，以及第一次使用或全部会话归档／删除后的空态。其中旧版富文本编辑器、完整消息组件和持久会话仍另行处理；后续最小内存对话接线见下文。用户明确移除“在外部对话窗口打开”按钮。

完成标准是预览可覆盖上述状态与键盘路径，自动检查通过，并由用户确认视觉效果后才能将共享组件接入产品。2026-09-25 用户确认既有交互无问题，并明确要求直接接入 App 后由用户测试。

## How

旧版基线为 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，核对时 HEAD `a45f5cd1ba197c76ae6b528d30f382f7080a5100`。入口取自 `xiaowei/src/pages/launcher/LauncherPage.tsx` 与 `modes.tsx`，标题栏取自 `QuickChatTitleBar.tsx`，窗口与输入布局参考 `QuickChatComposer.tsx`。对照的是源码行为，尚未完成旧版运行画面的逐像素核对。

- 空搜索输入（包括纯空格）按 ↓ 展开；非空输入的 ↑↓ 仍导航搜索结果。Quick Chat 中 Esc 收起；仅在编辑目标内且输入 `trim()` 为空时，↑ 收起。非编辑区域的 ↑、有内容时的 ↑ 不收起。
- 从搜索进入对话后，Esc 回搜索；搜索态再次 Esc 才模拟隐藏。Modal、标题栏菜单、重命名和模型菜单先处理自己的 Esc；输入法合成和 keyCode 229 不触发模式切换。
- 视口从 71px 展至 580px，滑轨同步采用 300ms ease-out，收起时保留聊天内容直到过渡结束，再换回搜索框并恢复焦点。反向切换清理旧计时器；输入区增高时消息区等量缩小，过渡中锁定消息滚动。
- 预览位于 `desktop/src/renderer/src/components/quick-chat/`。`QuickChatTransition` 控制视口与滑轨，`QuickChatTitleBar` 接收纯 props／回调，`QuickChatLauncherPreview` 只由 Storybook 和测试使用。搜索框通过 `LauncherSearchBar` 的 `embedded` 属性复用内容；产品默认结构不变。
- 内存 mock 覆盖新建、切换、首发建会话、发送、延迟回复、停止、改名、更新标题、归档和删除。最后一条移除后回到“新的对话／输入问题开始对话”空态。输入暂用 textarea，消息暂用文本布局，模型列表为固定数据。

Storybook 分组为 `Quick Chat / Launcher`，场景包含 Search、FirstUse、ExistingConversations、LastConversation、AllArchived、AllDeleted、SearchResults、SessionMenu、More、Rename、DeleteConfirmation。产品与 Storybook 的 UI 对齐约定见 [Renderer UI 开发](../../../desktop/src/renderer/README.md)。

### 最小内存对话（2026-09-25）

产品 Launcher 已接入 QuickChatPanel；标题栏最小模式仅显示当前首条消息标题与新对话操作，不接会话列表、自动标题、归档或工具能力。消息和草稿由 Launcher 持有的 useQuickChat hook 保存在 renderer 内存；收起、隐藏、切换剪贴板不删除消息，窗口销毁／刷新／退出后丢失。不使用文件、数据库或浏览器持久化存储。

前端通过 services.ts 的 Llm stream typed client 调用 Generate；不引入 Rust agent 或后端会话状态。ModelSettings 先订阅 ready 后 Get，处理迟到结果与 revision；每轮捕获当前默认 modelRef／thinkingLevel。不提供模型／思考强度选择控件，无默认模型、模型删除、凭据不可用或配置应用故障时显式报错并禁止发送；设置变更只影响后续请求，不影响在途快照。

chat-messages.ts 按块索引累计文本与 thinking，以成功终态中的完整 AssistantMessage 作为回放历史，保留签名、协议元数据与用量。取消或失败的部分回复仅用于显示，不当作成功 assistant 回放；用户消息保留。未收到终态即断流视为失败。请求不声明工具，意外工具输出报错并结束，不执行工具或继续循环。停止、清空及卸载会通过 AbortSignal 取消开流或在途流，旧请求不得覆盖新对话。

LauncherMode.QUICK_CHAT 仅表示原生窗口展示模式。宿主固定聊天高度 580px；展开先完成原生扩高再显示动画，收起后等待 300ms 再恢复搜索高度，聊天中搜索结果不缩小窗口。搜索快捷键在聊天模式下隐藏／恢复同一面板，剪贴板切换保留内存对话。输入使用纯文本 textarea，Enter 发送、Shift+Enter 换行，输入法合成不发送；Esc／空输入 ↑ 收起，新对话清空并停止在途生成。标题栏提供 Electron 拖动区域。

新增 Quick Chat / Chat 的 9 个 Storybook 场景仅使用模拟流；产品不导入预览适配器。旧完整标题栏和入口预览继续保留。本片是用户要求的简化实现，不宣称与旧版后端会话、工具循环、富文本消息或持久化全面等价。

## Outcome

2026-09-25 合并前 review 发现并修复两项问题：有效配置事件不能恢复初始读取错误、长对话收起后再展开丢失滚动位置。新增回归先复现 3 个失败场景，再验证修复；hook／面板／Launcher 合计 13 项通过。按用户反馈移除出字后的“正在生成”提示，保留等待首字、思考内容和停止按钮。无剩余 review 问题。

2026-09-25 最小内存对话已接入产品。完整 desktop 测试通过：27 项模块测试、7 项 main 测试、51 项 LLM 测试、87 项组件／页面测试、4 项 Rust typed 集成与 6 项业务集成；新增用例覆盖默认配置、多轮完整回放、开流取消、清空／卸载、迟到回复、断流、工具拒绝、窗口布局和模式切换。契约 codec、生成检查、Storybook 构建及 just check 通过，三个正式 napi 产物已重建／恢复。确认当前工作区实例后执行 just rs，23:46:21 新进程启动正常；未操作 UI 或发送真实模型请求。用户随后在 App 验证生成并确认能触发思考内容，要求 review 后合并。已完成本片验收，02 Plan 删除；以下首片结果保留为历史。

已实现组合预览和 11 个 Storybook 场景，去掉外部对话窗口打开按钮。24 项相关测试、desktop 类型检查、Biome 和 Storybook 构建通过。Chrome 中采样到展开 71px → 约 355px → 580px、收起 580px → 约 297px → 71px，并验证搜索焦点恢复和明暗状态。

当前仅为 Storybook 预览；尚未接真实 Launcher、模型、会话或用户数据，也未启动 Electron。用户视觉确认、旧版运行画面对照、原生窗口动画和真实输入法验收仍待完成。
