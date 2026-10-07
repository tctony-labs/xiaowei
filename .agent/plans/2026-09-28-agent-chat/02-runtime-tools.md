# 02：运行时与工具阶段索引

关联 [record](../../records/active/2026-09-28-agent-chat.md)与[总实施顺序](00-implementation-order.md)。统一 Host、文本执行、持久化与标题产品能力已交付；本阶段保留工具、交互、压缩、继续及辅助调用记录，不重复实现模型／napi 接线。

| 切片 | 剩余结果 | 前置 |
| --- | --- | --- |
| [02e](02e-tool-loop.md) | 顺序工具循环与结果闭合后继续生成 | 当前文本执行 |
| [02f](02f-interactions.md) | 两阶段交互、逐端接收确认与唯一决定 | 02e |
| [02g](02g-filesystem-tools.md) | 文件读写／搜索及实际权限闭环 | 02f |
| [02h](02h-bash-sandbox.md) | Bash、后台进程和 macOS 隔离 | 02g |
| [02i](02i-webfetch.md) | 网页读取与辅助模型提取 | 02e |
| [02j](02j-compaction.md) | 自动压缩与持久检查点 | 02e |
| [02k](02k-continue-recovery.md) | 显式 Continue 及未知副作用保护 | 02f、02g、02h、02j |
| [02l](02l-titles.md) | 辅助标题 Gen 的持久记录 | 当前标题与 rollout |

每片实施前核对旧版及当前文件，再原地收敛；不继续拆分。FollowUp／Steering／Preempt、rewind／fork 与 CLI／手机产品实现不在这些切片交付范围。每片完成后回填 record 并删除；全部完成后删除索引。
