# 00：剩余实施顺序

关联 [record](../../records/active/2026-09-28-agent-chat.md)。本文件只索引未完成切片，不是代码阶段；已交付成果与验证统一见[交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md)。保留原编号，不继续拆分后续计划。

## 当前基线与下一步

持久文本聊天、Header／Meta 精简 v2、核心 SQLite 目录、统一 Host、正式 Gateway／napi、会话管理／标题／模型控件与启动恢复已交付。已完成的会话管理、快照同步、napi、Host 和 composer 计划删除；缺少直接窗口复验的项目集中记录在交付证据，不保留重复实施步骤。

下一运行能力切片为 02e 工具循环。01f 大历史读取可独立推进，须在 03a 历史分页 UI 前完成；它不阻塞小会话的工具循环。各工具片依赖既有持久化、同一 App Server 与直接事件流，不重复创建服务、存储 adapter 或模型接线。后续片实施时核对旧版及最新实际文件，再原地调整范围。

## 剩余切片

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [01f](01f-history-projection.md) | Run／Item 历史有界分页及长内容读取 | 当前持久会话／投影 |
| [02e](02e-tool-loop.md) | 工具循环、意图／结果闭合与公共工具 Item | 当前文本执行／Host／rollout |
| [02f](02f-interactions.md) | 两阶段交互、逐端 ACK 与唯一决定 | 02e |
| [02g](02g-filesystem-tools.md) | 真实文件读写／搜索及 workspace 权限 | 02f |
| [02h](02h-bash-sandbox.md) | Bash／后台进程与 macOS 隔离 | 02g |
| [02i](02i-webfetch.md) | WebFetch 与辅助模型提取 | 02e |
| [02j](02j-compaction.md) | 自动压缩及检查点提交 | 02e |
| [02k](02k-continue-recovery.md) | 显式 Continue 与副作用保护 | 02f、02g、02h、02j |
| [02l](02l-titles.md) | 辅助标题 Gen 的独立持久记录 | 当前标题与 rollout |
| [03a](03a-history-ui.md) | Markdown／代码、消息复制与历史分页 UI | 展示可独立推进；分页依赖 01f |
| [03c](03c-tools-interaction-ui.md) | 工具和问答／权限卡片 | 02f；复用当前消息 UI |
| [03d](03d-composed-preview.md) | 新工具／压缩／继续状态的组合 UI 验收 | 03a、03c、02j、02k |
| [04d](04d-final-acceptance.md) | 全部基础工具的生产接线及完整验收 | 02e–02l、03d；01f／03a 的历史边界 |

## 实施约束

- 当前协议为 SubscribeSession 原子首帧 + 直接业务事件，不恢复 AgentViewCursor、instance／事件 revision、ReadChanges 或通知后逐 token 拉取。
- 已有包、文本 UI 和正式接线直接扩展；新增 crate／npm package 遵循仓库授权要求，不预建空接口或占位实现。
- 每片运行相关 Rust、契约、正式 addon／worker 和 renderer 检查；必要窗口验收从产品入口进行，不用 mock／日志代替。
- 当前 composer／hint 已按要求跳过 Storybook并接产品；后续只验收新增 UI，不重新建立一套文本面板。
- 文档更新回填 record，docs/ 不在本事项授权范围。冷启动由用户执行；确认本工作区活实例后才可 just rs。

每片完成即回填结果、删除计划并更新后继引用；所有剩余范围结束后删除索引。
