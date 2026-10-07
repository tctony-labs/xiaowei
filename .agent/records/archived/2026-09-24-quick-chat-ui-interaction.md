# Quick Chat 入口与窗口交互

## Why

迁移旧版 Quick Chat 时，先对齐 Launcher 入口：空搜索框按 ↓ 展开，聊天输入按 Esc 或空内容 ↑ 收起并返回搜索。旧版交互较成熟，需要同时核对动画、焦点、菜单优先级和空会话状态。

## What

提供可用的搜索／对话切换、标题栏、会话菜单、键盘和原生窗口协调，并用共享组件保留独立预览。用户已确认基础交互并要求接产品；“在外部对话窗口打开”按钮明确移除。

本事项承载入口、窗口与展示交互。初期 renderer 内存直调 LLM 已由[Agent Chat](../active/2026-09-28-agent-chat.md)取代；Agent 的持久会话、协议、模型选择、标题和工具范围统一在该事项维护，不重复保留旧执行方案。

## How

旧版参考 `xiaowei-next` 的 `a45f5cd1ba197c76ae6b528d30f382f7080a5100`：LauncherPage／modes、QuickChatTitleBar／QuickChatComposer。核对依据为源码，不宣称完成旧版运行画面的逐像素对齐。

入口迁移复用搜索窗口与展示组件，协调原生扩高／收起和动画时机；菜单、输入法与键盘处理遵守明确优先级。预览与产品共用组件，模拟服务不作为 Agent 运行或持久化验收依据。初期 renderer 内存直调 LLM 由 Agent Chat 取代，不保留第二套执行方案。

当前入口与窗口交互维护在 [desktop Quick Chat 文档](../../../desktop/docs/quick-chat.md)。运行、模型选择、持久会话及后续交互统一由 [Agent Chat](../active/2026-09-28-agent-chat.md) 承载，本 record 仅保留迁移理由、取舍与历史结果。

## Outcome

2026-10-07 按用户要求归档：基础入口与交互已获确认，后续相关事项继续在 Agent Chat 中处理。当前 desktop 说明已提取至包内文档；原记录中的最终 Electron 复验边界保留，搜索高亮闪动、系统剪贴板复制、原生拖动和首次设置跳转等剩余复验已交由 Agent Chat 的交付证据承载。


基础入口、动画、焦点、菜单及空态已接产品。用户已确认交互、模型空态／设置引导和搜索键盘滚动修复；原生快捷键卡顿修复也经实际按键确认，调度依据与结论统一见[快捷键事项](2026-09-18-fixed-launcher-shortcuts.md#原生快捷键与微任务调度)。临时采样、flushSync 尝试和调试开关均已撤回，不保留为当前设计。

组件／Launcher 回归覆盖滑轨高度、末项滚动、稳定订阅、直接展开、IME／Esc 优先级、设置导航 StrictMode、空白新建与菜单状态。相关 TS、Biome、Storybook 构建与桌面检查通过；Agent 迁移后的验证统一见[交付证据](../active/2026-09-28-agent-chat/implementation-results.md)。

最新持久会话菜单、模型选择恢复等窗口复验限制保留在 Agent 交付证据；搜索高亮闪动、系统剪贴板复制、原生拖动及首次设置跳转的最终 Electron 复验没有完整直接证据，不宣称全部平台验收结束。归档前本 record 用于承载当前入口行为，未保留内存 MVP／已完成接线计划；归档后由长期文档及 Agent Chat 承接。
