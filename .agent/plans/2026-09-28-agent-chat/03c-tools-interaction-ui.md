# 03c：工具与交互卡片预览

前置：[02f](02f-interactions.md)；复用现有消息 UI，长内容依赖 [01f](01f-history-projection.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：工具块和问答／权限卡片覆盖当前真实状态，接收确认与用户决定在 UI 中不混淆。

范围边界：不调用工具或审批 RPC，不将预览当真实权限能力。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `desktop/src/renderer/src/components/agent-chat/AgentToolCall.tsx、AgentInteraction.tsx、AgentInteraction.test.tsx` | 工具状态／详情、问答选项／自由输入、允许拒绝和已解决／失效 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/QuickChatPanel.tsx、quick-chat.css` 与对应 preview／story／测试 | 接工具／交互块展示、长路径／输出和多端解决 mock |

## 实施顺序

1. partial 工具参数不当最终可执行参数；详情长输出通过回调展开／读取，耗时缺失不伪造。
2. 卡片防重复提交，服务端决定为最终值；接收确认在 adapter 自动处理，卡片不发回执且确认收到不等于允许。
3. 固定 mock 覆盖成功／失败／取消／结果未知／后台工具及另一客户端已处理；不增加逐设备状态面板。

## 独立验收

- 组件测试、desktop check／Biome／storybook:build；检查明暗／窄视口并确认新增视觉。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
