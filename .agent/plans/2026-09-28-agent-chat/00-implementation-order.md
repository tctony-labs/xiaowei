# 00：剩余实施顺序

关联 [record](../../records/active/2026-09-28-agent-chat.md)。本文件只索引未完成切片，不是代码阶段；已交付成果与验证统一见[交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md)。保留原编号，不继续拆分后续计划。

## 当前基线与下一步

持久文本聊天、Header／Meta 精简 v2、核心 SQLite 目录、统一 Host、正式 Gateway／napi、会话管理／标题／模型控件与启动恢复已交付。已完成的会话管理、快照同步、napi、Host 和 composer 计划删除；缺少直接窗口复验的项目集中记录在交付证据，不保留重复实施步骤。

02e＋Read／Write／Edit、第 2 批前台 Bash 和第 3 批 Glob／Grep 已完成自动／正式链路与产品窗口验收，证据统一见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md)。第 4 批问答／权限及对应 UI 也已验收；第 5 批 TodoWrite 已实现并完成自动及真实模型验证；产品窗口／重启验收见交付证据。2026-10-27 用户将下一批扩为 WebFetch＋WebSearch，要求使用独立 crate 并可按需装配；当前先审 02i 计划。01f 大历史读取可独立推进，须在 03a 历史分页 UI 前完成；它不阻塞当前批次。各工具片依赖既有持久化、同一 App Server 与直接事件流；02i 只补独立工具注入接口；搜索配置与 Token 沿 desktop Settings，由装配方按当前源及单个明文 Key 创建具体实例，工厂返回 dyn SearchTool 对象，不新增 Agent 配置存储或模型接线。

2026-10-25 依据已提交代码复核：循环所有者为 `crates/xw-agent/src/run_loop.rs`，runtime 提供单次生成收集和工具原语；`tool_registry.rs` 与 `prompts/mod.rs` 分别装配声明和相应规则。后续工具接入这些实际入口，不恢复不存在的 runtime/agent_loop。当前不重新创建已完成的 02e 计划。

2026-10-10 用户确认暂缓 preset，技能后移；2026-10-18 补充登记 Todo 与 Skill，具体实现范围以后再定，位置见下表。依赖顺序仍为“上下文基线／增量机制 → tool → skill”：已接通 xw-agent 的提示词与第一批实际工具装配，后续按批次继续；不以 preset ID、revision、会话绑定或新增运行快照为前置。[讨论与源码依据](../../records/active/2026-09-28-agent-chat/agent-presets.md)保留在 record，恢复时按第二种实际模式的需求重新设计。

## 工具接入批次

2026-10-18 用户确认按批次实施，每批整体实现并验收后进入下一批，不按单个工具逐项交付；随后将 02e 的共用上下文同步／tool loop 与第一批文件工具合并实现与验收。下表为工具推进顺序，计划文件编号只用于定位，不代表执行先后。

| 批次 | 本批工具 | 承载计划 |
| --- | --- | --- |
| 1 | Read／Write／Edit，与工具循环一起交付 | [核心实现与证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18) |
| 2 | Bash，仅前台执行，已完成实现与验收 | [交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#前台-bash-与-macos-沙箱2026-10-25) |
| 3 | Glob／Grep，已完成实现与验收 | [交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#glob-与-grep-文件搜索2026-10-25) |
| 4 | AskUserQuestion／RequestPermission 及对应 UI，已完成本批验收 | [交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#问答权限与对应-ui2026-10-26) |
| 5 | TodoWrite，执行、持久恢复与清单卡片 | [交付证据](../../records/active/2026-09-28-agent-chat/implementation-results.md#todowrite-与清单卡片2026-10-27) |
| 6 | 独立 Web 工具 crate：WebFetch／WebSearch 与搜索源设置 | [02i 网页工具](02i-webfetch.md) |
| 7 | BgRun／BgOutput／BgStop | [02h 命令执行](02h-bash-sandbox.md)第二阶段 |
| 8 | Skill | 放在最后；先登记，具体范围与计划后续细化 |

文件工具先具备既有规则要求的权限检查；RequestPermission 接入前，需要额外授权且没有有效决定的操作返回权限不足，不为调整顺序放宽权限。前台 Bash 不包含后台启动参数或自动转后台行为。

前五批已验证旧会话的声明追加；2026-10-27 用户在 02i 调整后续装配规则：默认工具集按稳定 ID 更新，本进程已有 session 保留工具暴露快照，新 session 使用新集合。搜索 provider 的内存更新对 session 透明，已有 session 后续搜索可使用新源而不改变声明／规则。用户允许重启后按当前配置重新装配；恢复声明有差异时仍遵守既有增量和 provider 能力校验，不静默重写全量声明。

## 下一批的执行入口

2026-10-25 用户调整：进入第 4 批工具前，先联合实施 [03a](03a-history-ui.md) 的 Markdown／代码／复制与 [03c](03c-tools-interaction-ui.md) 的有序现有工具展示。本批已接产品并移除旧 Run 聚合展示，当前 Generate 与最终回复归属已接线；自动检查、正式原生链路、浏览器和当前工作区真实 sol 窗口、系统复制、停止／失败、Edit diff 及重启不重放均已验收，见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。03a／03c 现仅保留依赖 01f 的历史分页／完整长内容；问答／权限 UI 已随第 4 批完成。

2026-10-26 第 4 批两个工具、两阶段送达／决定和产品 UI 已实现并完成本批验收，用户手动记录已核对；Stop／草稿、重启失效／不重放、后续新 Run 和明暗主题已补验。02f 已删除，03c 仅保留长输出，真实 IME 平台复核仍在 04d，证据见[本批结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#问答权限与对应-ui2026-10-26)。

1. 第 5 批 TodoWrite 已完成实现与验收，证据见交付结果；下一工具批为 02i WebFetch／WebSearch 与搜索源设置，当前先审计划，不提前展开后台工具、Skill 或 preset。
2. 01f 的历史读取可独立推进，03a／03c 等其公共接口；不因工具 UI 已完成而放宽完整快照预算。后台工具仍等第 7 批。

工具批次之外，01f／03a（历史读取与展示）、02j（压缩）和 02l（辅助标题记录）可在各自前置满足时独立实施，完整完成后再汇入 03d／04d；本次不将它们插入工具批次，Skill 的具体范围仍待明确。

工具删除／同名替换的 provider 适配须在允许动态工具撤销／替换或依赖此能力的 Skill 之前完成；原生 Responses Lite 与缓存收益另按真实代理路径验收。它们是明确的未完成边界，不把新工具批次的成功当成已解决这些问题。

## 剩余切片

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [01f](01f-history-projection.md) | Run／Item 历史有界分页及长内容读取 | 当前持久会话／投影 |
| [02h](02h-bash-sandbox.md) | 第 7 批后台工具 | 第一阶段前台 Bash 已验收；第 7 批接第 6 批 |
| [02i](02i-webfetch.md) | WebFetch 与辅助模型提取、WebSearch、搜索源设置及对应 UI | 第 5 批完成 |
| Skill（已登记） | 具体实现范围后续确定；按生命周期验证所需 provider 更新 | 第 7 批完成，工具批次最后实施 |
| [02j](02j-compaction.md) | 自动压缩及检查点提交 | 已交付工具循环 |
| [02k](02k-continue-recovery.md) | 显式 Continue 与副作用保护 | 已交付交互、02h、02j；文件搜索已交付 |
| [02l](02l-titles.md) | 辅助标题 Gen 的独立持久记录 | 当前标题与 rollout |
| [03a](03a-history-ui.md) | 历史分页／完整长内容 UI | 01f；复用已交付 Markdown／代码和消息复制 |
| [03c](03c-tools-interaction-ui.md) | 完整工具长输出 | 01f；现有工具和问答／权限 UI 已交付 |
| [03d](03d-composed-preview.md) | 新工具／压缩／继续状态的组合 UI 验收 | 03a、03c、02j、02k |
| [04d](04d-final-acceptance.md) | 全部工具批次的生产接线及完整验收 | 后续工具与 02h–02l、03d；Skill 后续确认范围；01f／03a 的历史边界 |

## 实施约束

- 当前协议为 SubscribeSession 原子首帧 + 直接业务事件，不恢复 AgentViewCursor、instance／事件 revision、ReadChanges 或通知后逐 token 拉取。
- 已有包、文本 UI 和正式接线直接扩展；新增 crate／npm package 遵循仓库授权要求，不预建空接口或占位实现。
- 每片运行相关 Rust、契约、正式 addon／worker 和 renderer 检查；必要窗口验收从产品入口进行，不用 mock／日志代替。
- 当前 composer／hint 已按要求跳过 Storybook并接产品；后续只验收新增 UI，不重新建立一套文本面板。
- 文档更新回填 record，docs/ 不在本事项授权范围。冷启动由用户执行；确认本工作区活实例后才可 just rs。

每片完成即回填结果、删除计划并更新后继引用；所有剩余范围结束后删除索引。
