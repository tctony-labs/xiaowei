# 02：运行时与工具阶段索引

关联 [record](../../records/active/2026-09-28-agent-chat.md)与[总实施顺序](00-implementation-order.md)。统一 Host、文本执行、持久化与标题产品能力已交付；本阶段接提示词与工具、交互、压缩、继续及辅助调用记录。preset 暂缓；TodoWrite 已按第 5 批实现，Skill 的具体范围仍待确定，不重复实现模型／napi 接线。

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [02h](02h-bash-sandbox.md) | 第 7 批后台工具 | 前台 Bash 已验收；后台接第 6 批网页工具 |
| [02i](02i-webfetch.md) | 第 6 批独立 Web 工具 crate、辅助提取与搜索设置 | 第 5 批完成；当前先审计划 |
| Skill（已登记） | 第 8 批，最后实施，具体范围后续确定 | 第 7 批完成 |
| [02j](02j-compaction.md) | 自动压缩与持久检查点 | 已交付工具循环 |
| [02k](02k-continue-recovery.md) | 显式 Continue 及未知副作用保护 | 已交付交互、02h、02j；文件搜索已交付 |
| [02l](02l-titles.md) | 辅助标题 Gen 的持久记录 | 当前标题与 rollout |

工具批次及确切工具集合以[总实施顺序](00-implementation-order.md#工具接入批次)为准，按批整体验收。每片实施前核对旧版及当前文件，再原地收敛；不继续拆分。跨批次计划在阶段完成后回填成果、移除已完成步骤，剩余阶段继续保留。FollowUp／Steering／Preempt、rewind／fork 与 CLI／手机产品实现不在这些切片交付范围。每片全部完成后回填 record 并删除；全部完成后删除索引。

02e 与前四批工具均已完成本批验收，不重复建计划；第 5 批 TodoWrite 已实现并验证，后续从第 6 批 WebFetch／WebSearch 推进。当前模型／工具编排在 core 的 `run_loop.rs`，runtime 提供生成收集和工具原语；后续交互／压缩沿此边界扩展。删除／同名替换的 provider 适配、原生 Lite 与缓存收益是独立限制，不因核心记录支持就视为全部打通，详见[正式生成接线](../../records/active/2026-09-28-agent-chat/model-types.md#正式生成接线与适配边界2026-10-18)。
