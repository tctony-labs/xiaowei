# 03：剩余 Chat UI

关联 [record](../../records/active/2026-09-28-agent-chat.md)与[总实施顺序](00-implementation-order.md)。现有 Quick Chat 已接 Markdown／代码块、可折叠思考、原文复制、有序工具展示、textarea、发送／停止、模型／思考 chip、hint、标题与会话菜单。不重做已交付组件或重复要求 composer Storybook。

2026-10-25 用户要求先完成 03a 的正文展示和 03c 的现有工具部分，再进入问答／权限工具。本批预览经用户确认后已接入产品；当前 Generate、最终回复归属和历史恢复通过真实快照／事件驱动，旧聚合展示已移除。Codex `app.asar` 的参考与明确调整维护在 [record](../../records/active/2026-09-28-agent-chat/runtime-ui.md#codex-桌面参考与本批适配2026-10-25)。自动、正式原生链路、浏览器和实际 sol 窗口、系统复制、停止／失败、Edit diff 与重启恢复验收已通过，见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。03a／03c 现仅保留依赖 01f 的剩余范围。

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [03a](03a-history-ui.md) | 历史分页／完整长内容 UI | 01f；复用已交付的消息组件 |
| [03c](03c-tools-interaction-ui.md) | 完整工具长输出 | 01f；现有工具和问答／权限 UI 已交付 |
| [03d](03d-composed-preview.md) | 工具／压缩／继续状态的组合交互确认 | 03a、03c、02j、02k |

2026-10-26 问答／权限工具与对应 UI 已完成本批验收，双入口、停止和恢复证据见[本批结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#问答权限与对应-ui2026-10-26)。02f 已删除，03c 只保留完整工具长输出；真实 IME 的完整平台复核继续随 04d 保留。

后续只补实际新增 UI，复用旧版风格及当前共享组件；fixture／预览用于新增状态确认，本批真实权限和副作用链路随 02f／03c 验收，04d 再覆盖完整组合。各片实施前复核文件，不预建第二套 AgentChatView／Composer。每片完成回填并删除，全部结束后删除索引。
