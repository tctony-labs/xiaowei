# Quick Chat 入口交互预览

## Why

用户要求迁移旧版 Quick Chat 时优先核对 Launcher 入口：空搜索框按 ↓ 展开，聊天输入按 Esc 或空内容时按 ↑ 收起并返回搜索框。旧版交互已比较成熟，迁移应先在 Storybook 对齐动画、焦点、菜单优先级和空会话状态。

## What

本事项只交付 Storybook 中可独立操作的 Quick Chat 入口交互预览：搜索与对话切换、标题栏、模拟会话操作，以及第一次使用或全部会话归档／删除后的空态。产品接线、真实会话、模型调用、旧版富文本编辑器与消息组件、原生窗口验收均另行处理。用户明确移除“在外部对话窗口打开”按钮。

完成标准是预览可覆盖上述状态与键盘路径，自动检查通过，并由用户确认视觉效果后才能将共享组件接入产品。当前用户视觉确认尚未完成，因此本事项继续留在 active。

## How

旧版基线为 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，核对时 HEAD `a45f5cd1ba197c76ae6b528d30f382f7080a5100`。入口取自 `xiaowei/src/pages/launcher/LauncherPage.tsx` 与 `modes.tsx`，标题栏取自 `QuickChatTitleBar.tsx`，窗口与输入布局参考 `QuickChatComposer.tsx`。对照的是源码行为，尚未完成旧版运行画面的逐像素核对。

- 空搜索输入（包括纯空格）按 ↓ 展开；非空输入的 ↑↓ 仍导航搜索结果。Quick Chat 中 Esc 收起；仅在编辑目标内且输入 `trim()` 为空时，↑ 收起。非编辑区域的 ↑、有内容时的 ↑ 不收起。
- 从搜索进入对话后，Esc 回搜索；搜索态再次 Esc 才模拟隐藏。Modal、标题栏菜单、重命名和模型菜单先处理自己的 Esc；输入法合成和 keyCode 229 不触发模式切换。
- 视口从 71px 展至 580px，滑轨同步采用 300ms ease-out，收起时保留聊天内容直到过渡结束，再换回搜索框并恢复焦点。反向切换清理旧计时器；输入区增高时消息区等量缩小，过渡中锁定消息滚动。
- 预览位于 `desktop/src/renderer/src/components/quick-chat/`。`QuickChatTransition` 控制视口与滑轨，`QuickChatTitleBar` 接收纯 props／回调，`QuickChatLauncherPreview` 只由 Storybook 和测试使用。搜索框通过 `LauncherSearchBar` 的 `embedded` 属性复用内容；产品默认结构不变。
- 内存 mock 覆盖新建、切换、首发建会话、发送、延迟回复、停止、改名、更新标题、归档和删除。最后一条移除后回到“新的对话／输入问题开始对话”空态。输入暂用 textarea，消息暂用文本布局，模型列表为固定数据。

Storybook 分组为 `Quick Chat / Launcher`，场景包含 Search、FirstUse、ExistingConversations、LastConversation、AllArchived、AllDeleted、SearchResults、SessionMenu、More、Rename、DeleteConfirmation。产品与 Storybook 的 UI 对齐约定见 [Renderer UI 开发](../../../desktop/src/renderer/README.md)。

## Current work

等待用户确认当前预览的视觉与动画效果；确认后才安排产品接入。后续输入编辑器、模型控件、消息展示、真实会话、原生窗口及输入法验收按各自依赖另取小切片，不保留并行实施 Plan。模型调用层作为独立事项推进。

## Outcome

已实现组合预览和 11 个 Storybook 场景，去掉外部对话窗口打开按钮。24 项相关测试、desktop 类型检查、Biome 和 Storybook 构建通过。Chrome 中采样到展开 71px → 约 355px → 580px、收起 580px → 约 297px → 71px，并验证搜索焦点恢复和明暗状态。

当前仅为 Storybook 预览；尚未接真实 Launcher、模型、会话或用户数据，也未启动 Electron。用户视觉确认、旧版运行画面对照、原生窗口动画和真实输入法验收仍待完成。
