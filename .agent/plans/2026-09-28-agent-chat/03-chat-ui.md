# 03：剩余 Chat UI

关联 [record](../../records/active/2026-09-28-agent-chat.md)与[总实施顺序](00-implementation-order.md)。现有 Quick Chat 已接纯文本正文、可折叠思考、textarea、发送／停止、模型／思考 chip、hint、标题与会话菜单；Markdown／代码块及消息复制尚未实现。不重做已交付组件或重复要求 composer Storybook。

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [03a](03a-history-ui.md) | Markdown／代码、消息复制与历史分页 UI | Markdown／代码展示可独立推进；分页依赖 01f |
| [03c](03c-tools-interaction-ui.md) | 工具与问答／权限卡片 | 02f；复用当前消息 UI |
| [03d](03d-composed-preview.md) | 工具／压缩／继续状态的组合交互确认 | 03a、03c、02j、02k |

后续只补实际新增 UI，复用旧版风格及当前共享组件；mock／预览用于新增状态确认，实际权限和副作用链路在 04d 验收。各片实施前复核文件，不预建第二套 AgentChatView／Composer。每片完成回填并删除，全部结束后删除索引。
