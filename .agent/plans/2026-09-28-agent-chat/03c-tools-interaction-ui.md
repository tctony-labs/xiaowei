# 03c：工具与交互 UI

现有工具部分与 [03a](03a-history-ui.md) 一起先行实施；问答／权限卡片仍以前置 [02f](02f-interactions.md) 为准，完整长内容读取依赖 [01f](01f-history-projection.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：工具块和问答／权限卡片覆盖当前真实状态，接收确认与用户决定在 UI 中不混淆。

范围边界：本片消费公开工具／交互投影，不实现新的工具执行或审批 RPC，不将 mock 当真实权限能力。

2026-10-25 本批现有 Read／Write／Edit／Bash／Glob／Grep 的有序工具块已在用户确认预览后接产品：紧凑可展开行、参数与输出分开、真实终态、文件 diff、长路径与输出滚动均复用同一组件，删除预览专用分派。自动、正式链路及当前工作区真实 sol 窗口验收通过，覆盖分组／展开、停止、失败、Edit diff 和重启不重放，见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。完成过程折叠与格式化规则见 [record](../../records/active/2026-09-28-agent-chat/runtime-ui.md#codex-桌面参考与本批适配2026-10-25)。等待／后台等未公开状态不伪造；AskUserQuestion／RequestPermission 卡片及回应后续实施。

消息 Story 已按 Run／Generate 阶段重整，单次／连续／正文分隔调用分别预览，调用方式与执行阶段使用控件。旧工具状态大拼盘已移除，失败、停止、未知结果放入事实一致的 Run；工具声明生成中不展示为执行中工具。当前 Generate 首次等待及空最终回复规则统一见 runtime-ui，不接新工具或交互 RPC。

本片剩余：02f 的问答／权限交互投影、回应防重、多端解决与失效状态，以及 01f 的完整工具长输出读取；已接的现有工具展示不重复设计。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增（本批） | `desktop/src/renderer/src/components/agent-chat/{AgentToolCall,AgentToolGroup,AgentToolIcon}.tsx`、`tool-presentation.ts` 及相邻测试 | 单条／活跃组共享动作与目标格式化，结束组按参考的动作类别汇总；左侧图标、尾部箭头，组内工具及参数／输出／文件 diff 不缩进，新增调用及同 Item 完成时保留展开状态 |
| 新增（后续） | `desktop/src/renderer/src/components/agent-chat/AgentInteraction.tsx、AgentInteraction.test.tsx` | 问答选项／自由输入、允许拒绝和已解决／失效 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/QuickChatPanel.tsx、quick-chat.css` 与对应组件测试 fixture／测试 | 接工具／交互块展示、长路径／输出和多端解决 mock |

## 实施顺序

1. partial 工具参数不当最终可执行参数；详情长输出通过回调展开／读取；工具组及工具行不展示耗时，整轮完成后的过程折叠入口仅显示真实总用时，不展示调用次数。
   正常完成不显示状态标签；执行／输出中的当前内容使用流光；失败／结果未知紧邻名称提示，不在最右侧单列状态。
   单条与组标题的动作归类、参数格式和源码依据统一见 [record 的参考核对](../../records/active/2026-09-28-agent-chat/runtime-ui.md#codex-桌面参考与本批适配2026-10-25)，不在本 Plan 重复维护规则。
2. 卡片防重复提交，服务端决定为最终值；接收确认在 adapter 自动处理，卡片不发回执且确认收到不等于允许。
3. 固定 mock 覆盖成功／失败／取消／结果未知／后台工具及另一客户端已处理；不增加逐设备状态面板。

## 独立验收

- 组件测试、desktop check／Biome／desktop build；在现有客户端检查明暗／窄视口及新增视觉。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
