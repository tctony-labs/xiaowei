# 03c：完整工具长输出 UI

关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。有序工具块、格式化分组、diff 和问答／权限卡片已接产品并完成本批验收，分别见[现有工具 UI 证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)和[问答／权限证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#问答权限与对应-ui2026-10-26)。双入口、防重、多端状态、停止和恢复不再列为待实施工作；真实输入法的完整平台复核仍随 04d 跟踪。

本片只保留依赖 [01f](01f-history-projection.md) 的完整工具长输出读取。当前工具自身的输出上限与公开快照预算保持；不把既有截断输出声称为可读取的完整原文，不改写 journal，不重做已交付卡片或引入另一套消息展示。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `desktop/src/renderer/src/components/agent-chat/AgentToolCall.tsx` 及相邻测试 | 按 01f 确定的内容读取接口，区分预览和可获取的完整内容；展示加载、失败与重试，保留参数／输出分区及既有展开状态 |
| 修改 | `desktop/src/renderer/src/components/agent-chat/client.ts`、`message-blocks.ts` 及相邻测试 | 接入实际读取与缓存，按 Session／Run／Item 稳定身份和切换代次隔离；不让迟到结果覆盖新会话 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/use-quick-chat.ts`、`QuickChatPanel.tsx` 及相邻测试 | 从页面适配层传递读取回调，展示组件不自建 Gateway 连接 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/quick-chat.css` | 覆盖长中文、长行及内部滚动，详情展开保持无横向缩进 |
| 修改 | `desktop/docs/quick-chat.md` | 同步完整工具内容的读取和失败行为 |

具体读取字段与分页规则随 01f 确定，不预建空 RPC、假完整内容或固定实现包装。

## 实施顺序与验证

1. 01f 完成后，核对已提交完整内容与显示预览的关系，复用 03a 的长内容读取状态和错误处理，不从 UI 缓存重建模型上下文。
2. 按稳定 Item 身份读取完整工具内容，区分加载／失败／重试和原始内容本就已截断；停止或切换会话不接纳过期读取结果。
3. 组件及 typed Gateway 测试覆盖长中文完整拼回、加载失败后重试、切换与迟到响应、原展开和滚动位置保持。通过 desktop check、受影响 Biome 和相关测试，再在当前工作区实际窗口验收。

沿用既有工具图标和格式化标题、尾部箭头、参数与输出分区、正常完成无额外状态及整轮折叠仅显示总用时；不重新设计问答／权限或把它们混入普通工具组。

完成后回填实际行为与验证，删除本 Plan。
