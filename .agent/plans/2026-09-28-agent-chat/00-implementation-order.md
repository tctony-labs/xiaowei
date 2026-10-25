# 00：剩余实施顺序

关联 [record](../../records/active/2026-09-28-agent-chat.md)。本文件只索引未完成切片，不是代码阶段；已交付成果与验证统一见[交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md)。保留原编号，不继续拆分后续计划。

## 当前基线与下一步

持久文本聊天、Header／Meta 精简 v2、核心 SQLite 目录、统一 Host、正式 Gateway／napi、会话管理／标题／模型控件与启动恢复已交付。已完成的会话管理、快照同步、napi、Host 和 composer 计划删除；缺少直接窗口复验的项目集中记录在交付证据，不保留重复实施步骤。

02e＋Read／Write／Edit 已完成核心、正式链路及产品入口验收，证据见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18)。第 2 批前台 Bash 已完成自动／真实模型和产品窗口验收，具体见 [Bash 结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#前台-bash-与-macos-沙箱2026-10-25)；下一批为 Glob／Grep。01f 大历史读取可独立推进，须在 03a 历史分页 UI 前完成；它不阻塞当前批次。各工具片依赖既有持久化、同一 App Server 与直接事件流，不重复创建服务、存储 adapter 或模型接线。

2026-10-25 依据已提交代码复核：循环所有者为 `crates/xw-agent/src/run_loop.rs`，runtime 提供单次生成收集和工具原语；`tool_registry.rs` 与 `prompts/mod.rs` 分别装配声明和相应规则。后续工具接入这些实际入口，不恢复不存在的 runtime/agent_loop。当前不重新创建已完成的 02e 计划。

2026-10-10 用户确认暂缓 preset，技能后移；2026-10-18 补充登记 Todo 与 Skill，具体实现范围以后再定，位置见下表。依赖顺序仍为“上下文基线／增量机制 → tool → skill”：已接通 xw-agent 的提示词与第一批实际工具装配，后续按批次继续；不以 preset ID、revision、会话绑定或新增运行快照为前置。[讨论与源码依据](../../records/active/2026-09-28-agent-chat/agent-presets.md)保留在 record，恢复时按第二种实际模式的需求重新设计。

## 内置工具接入批次

2026-10-18 用户确认按批次实施，每批整体实现并验收后进入下一批，不按单个工具逐项交付；随后将 02e 的共用上下文同步／tool loop 与第一批文件工具合并实现与验收。下表为工具推进顺序，计划文件编号只用于定位，不代表执行先后。

| 批次 | 本批工具 | 承载计划 |
| --- | --- | --- |
| 1 | Read／Write／Edit，与工具循环一起交付 | [核心实现与证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18) |
| 2 | Bash，仅前台执行，已完成实现与验收 | [交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#前台-bash-与-macos-沙箱2026-10-25) |
| 3 | Glob／Grep | [02g 文件搜索](02g-filesystem-tools.md) |
| 4 | AskUserQuestion／RequestPermission | [02f 交互](02f-interactions.md) |
| 5 | Todo | 先登记，具体范围与计划后续细化 |
| 6 | WebFetch | [02i 网页读取](02i-webfetch.md) |
| 7 | BgRun／BgOutput／BgStop | [02h 命令执行](02h-bash-sandbox.md)第二阶段 |
| 8 | Skill | 放在最后；先登记，具体范围与计划后续细化 |

文件工具先具备既有规则要求的权限检查；RequestPermission 接入前，需要额外授权且没有有效决定的操作返回权限不足，不为调整顺序放宽权限。前台 Bash 不包含后台启动参数或自动转后台行为。

每批注册新增工具时必须覆盖旧会话：保留旧系统基线和已有文件工具 schema，只追加新增声明及新规则，再经正式 worker 验证后续生成。当前适配拒绝删除／同名替换；这不阻塞固定集合上的新增批次，但不支持该增量的 provider 必须保留明确错误，不能静默重写全量声明或在旧会话丢掉工具。

## 下一批的执行入口

1. 按 [02g](02g-filesystem-tools.md)核对旧版与当前文件搜索实现，接入 Glob／Grep，并验证路径、权限、输出边界及旧会话新增声明。
2. 经正式 addon／worker 与 Quick Chat 完成本批搜索验收，再进入问答／权限；前台 Bash 已验收，不重复实施，后台工具仍等第 7 批。

工具批次之外，01f／03a（历史读取与展示）、02j（压缩）和 02l（辅助标题记录）可在各自前置满足时独立实施，完整完成后再汇入 03d／04d；本次不将它们插入工具批次，也不将未明确范围的 Todo／Skill 描述为可直接实施。

工具删除／同名替换的 provider 适配须在允许动态工具撤销／替换或依赖此能力的 Skill 之前完成；原生 Responses Lite 与缓存收益另按真实代理路径验收。它们是明确的未完成边界，不把新工具批次的成功当成已解决这些问题。

## 剩余切片

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [01f](01f-history-projection.md) | Run／Item 历史有界分页及长内容读取 | 当前持久会话／投影 |
| [02h](02h-bash-sandbox.md) | 第 7 批后台工具 | 第一阶段前台 Bash 已验收；第 7 批接第 6 批 |
| [02g](02g-filesystem-tools.md) | Glob／Grep 搜索及边界 | 第 2 批完成 |
| [02f](02f-interactions.md) | 两阶段交互、逐端 ACK 与唯一决定 | 第 3 批完成 |
| Todo（已登记） | 具体实现范围后续确定 | 第 4 批完成 |
| [02i](02i-webfetch.md) | WebFetch 与辅助模型提取 | 第 5 批完成 |
| Skill（已登记） | 具体实现范围后续确定；按生命周期验证所需 provider 更新 | 第 7 批完成，工具批次最后实施 |
| [02j](02j-compaction.md) | 自动压缩及检查点提交 | 已交付工具循环 |
| [02k](02k-continue-recovery.md) | 显式 Continue 与副作用保护 | 02f、02g、02h、02j |
| [02l](02l-titles.md) | 辅助标题 Gen 的独立持久记录 | 当前标题与 rollout |
| [03a](03a-history-ui.md) | Markdown／代码、消息复制与历史分页 UI | 展示可独立推进；分页依赖 01f |
| [03c](03c-tools-interaction-ui.md) | 工具和问答／权限卡片 | 02f；复用当前消息 UI |
| [03d](03d-composed-preview.md) | 新工具／压缩／继续状态的组合 UI 验收 | 03a、03c、02j、02k |
| [04d](04d-final-acceptance.md) | 全部工具批次的生产接线及完整验收 | 02f–02l、03d；Todo／Skill 后续确认范围；01f／03a 的历史边界 |

## 实施约束

- 当前协议为 SubscribeSession 原子首帧 + 直接业务事件，不恢复 AgentViewCursor、instance／事件 revision、ReadChanges 或通知后逐 token 拉取。
- 已有包、文本 UI 和正式接线直接扩展；新增 crate／npm package 遵循仓库授权要求，不预建空接口或占位实现。
- 每片运行相关 Rust、契约、正式 addon／worker 和 renderer 检查；必要窗口验收从产品入口进行，不用 mock／日志代替。
- 当前 composer／hint 已按要求跳过 Storybook并接产品；后续只验收新增 UI，不重新建立一套文本面板。
- 文档更新回填 record，docs/ 不在本事项授权范围。冷启动由用户执行；确认本工作区活实例后才可 just rs。

每片完成即回填结果、删除计划并更新后继引用；所有剩余范围结束后删除索引。
