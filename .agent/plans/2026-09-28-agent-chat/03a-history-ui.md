# 03a：Markdown／代码与历史分页 UI

关联 [record](../../records/active/2026-09-28-agent-chat.md) 与[总实施顺序](00-implementation-order.md)。当前已接 Markdown／代码块、可折叠思考、原文复制与有序历史恢复；本片剩余大历史分页／完整长内容交互，复用现有面板，依赖 [01f](01f-history-projection.md)，不继续拆分切片。

2026-10-25 用户要求先于 AskUserQuestion／RequestPermission 实施本片的正文展示与 03c 的现有工具 UI。用户确认调整后的 Storybook 后，已将有序内容块、Markdown／代码、原文复制和现有工具详情接入产品，自动、正式链路及当前工作区真实 sol 窗口／系统复制／重启验收通过；历史分页／完整长内容读取仍待 01f，不因本批展示完成删除本 Plan。

## 文件与改动

已完成产品接线：Agent 契约补当前 Generate 的身份、开始时间、已收到内容及活跃 Item，通过快照与有序事件同步；响应 Item 关联 Gen，正常终态明确最终 Gen，历史从既有 Journal 重建，不新增模型 `final_answer` 阶段或修改传输层。Panel 直接复用已确认的组件，已删除预览专用分派与旧的按类型聚合展示。实际验证与剩余范围统一见 [交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md)。

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `desktop/src/renderer/src/components/agent-chat/{message-blocks.ts,AgentMessage.tsx,AgentMarkdown.tsx,AgentCopyButton.tsx,AgentReasoning.tsx}` 及相邻测试 | 以稳定 Item ID 保留正文／思考／工具顺序；渲染 GFM、可横向滚动的代码／表格，复制原始 Markdown 和代码；思考默认显示末行，可展开全文；复制／链接失败可见 |
| 新增 | `desktop/src/renderer/src/components/quick-chat/QuickChatMessagesPreview.tsx` 及相邻 stories | 复用现有 Panel，覆盖交错工具、流式／未闭合围栏、长中文、明暗与窄视口；确认前不改变产品展示 |
| 修改 | `desktop/src/renderer/src/components/agent-chat/{client,agent-events}.ts` 及相邻测试 | 接 01f 的历史页／长内容读取，保持订阅权威、去重、切换代次及错误隔离 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/{QuickChatPanel.tsx,use-quick-chat.ts}`及相邻测试 | 接入 Markdown／代码块与消息复制，保留原始文本；增加加载旧历史、明确预览截断和完整内容读取，不从可见内容重建模型上下文 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/quick-chat.css` | 补 Markdown／代码块、加载／预览状态和滚动布局 |

实施时核对实际扩展位置，只列变更需要的组件，不强制新增 AgentMessageList／AgentMarkdown 包装层。

已完成有序投影、Generate 生命周期、空最终回复、复制／链接与工具状态测试；预览仍保留 12 个消息场景，用控件覆盖各变体。参考行为、用户明确调整和格式化规则只维护在 [record 核对表](../../records/active/2026-09-28-agent-chat/runtime-ui.md#参考行为逐项核对)。同次 Generate 先投影 response、完整校验后再执行工具的顺序保持不变。

本片剩余：01f 完成后的历史分页、长内容完整读取及相应失败／重试／滚动验收。不新建第二套消息组件，不从可见内容重建模型上下文；问答／权限 UI 已随第 4 批交付，验证范围见 record。

## 独立验收

复用已有 react-markdown／remark-gfm 依赖，不默认增加高亮或编辑器依赖。组件测试验证流式 Markdown、代码围栏及长行、链接、消息复制原文和思考折叠；typed client 测试覆盖旧页加载、消息顺序、实时更新、切换／迟到响应、长中文内容完整复制、加载失败重试及滚动位置保持。执行 desktop check／受影响 Biome，产品检查明暗／窄窗口及向上加载的滚动体验。

完成后回填历史展示行为与验证，删除本片。
