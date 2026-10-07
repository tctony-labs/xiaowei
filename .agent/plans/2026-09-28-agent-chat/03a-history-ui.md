# 03a：Markdown／代码与历史分页 UI

关联 [record](../../records/active/2026-09-28-agent-chat.md) 与[总实施顺序](00-implementation-order.md)。当前已接纯文本正文、可折叠思考与文本历史恢复；本片补 Markdown 解析、代码块渲染、消息复制及大历史分页／长内容交互，复用现有面板。展示部分可基于当前接口推进，历史分页依赖 [01f](01f-history-projection.md)，不继续拆分切片。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `desktop/src/renderer/src/components/agent-chat/{client,agent-events}.ts` 及相邻测试 | 接 01f 的历史页／长内容读取，保持订阅权威、去重、切换代次及错误隔离 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/{QuickChatPanel.tsx,use-quick-chat.ts}`及相邻测试 | 接入 Markdown／代码块与消息复制，保留原始文本；增加加载旧历史、明确预览截断和完整内容读取，不从可见内容重建模型上下文 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/quick-chat.css` | 补 Markdown／代码块、加载／预览状态和滚动布局 |

实施时核对实际扩展位置，只列变更需要的组件，不强制新增 AgentMessageList／AgentMarkdown 包装层。

## 独立验收

复用已有 react-markdown／remark-gfm 依赖，不默认增加高亮或编辑器依赖。组件测试验证流式 Markdown、代码围栏及长行、链接、消息复制原文和思考折叠；typed client 测试覆盖旧页加载、消息顺序、实时更新、切换／迟到响应、长中文内容完整复制、加载失败重试及滚动位置保持。执行 desktop check／受影响 Biome，产品检查明暗／窄窗口及向上加载的滚动体验。

完成后回填历史展示行为与验证，删除本片。
