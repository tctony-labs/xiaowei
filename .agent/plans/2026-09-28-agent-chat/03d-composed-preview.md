# 03d：工具、压缩与继续的组合 UI 确认

前置：[03a](03a-history-ui.md)、[03c](03c-tools-interaction-ui.md)、[02j](02j-compaction.md)、[02k](02k-continue-recovery.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：在现有 Quick Chat 组合新增工具／交互、压缩与继续状态，确认产品接入所需的新交互；已交付文本与 chip 不重新验收。

范围边界：不改变现有产品 QuickChatPanel／Launcher 的视觉。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `desktop/src/renderer/src/components/quick-chat/QuickChatChatPreview.tsx、QuickChatLauncherPreview.tsx` | 复用现有面板与 composer，组合新增状态，预览回调不执行业务 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/` 对应 stories／测试 | 扩充现有 transition／标题栏组合预览，不新增另一套入口 |
| 修改 | `desktop/src/renderer/src/components/quick-chat/quick-chat.css` 及 03c 新增组件 | 加入压缩、继续、标题任务与完整异常场景，复用已确认组件 |

## 实施顺序

1. 核对旧 chat／QuickChatComposer，textarea 是已确认简化，不宣称完整复刻。
2. 覆盖首用／无模型、多会话／归档、长内容、压缩失败、存储失败／断流、Continue、标题竞争与删除确认。
3. 580px 现有 Launcher 范围、菜单／Modal Esc 优先、长路径不溢出；模型缺省和 small_text 缺失提示保持现有入口。

## 独立验收

- 组件测试、desktop check／Biome／storybook:build；浏览器固定主题／字体／视口检查并由用户确认组合视觉。
- 记录已确认具体范围，真实输入法、窗口焦点与尺寸留到 04d；新增状态确认后接产品，不重复迁移现有文本链路。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
