# 02h：Bash、后台进程与隔离

前置：第 7 批接 [02i WebFetch](02i-webfetch.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与[工具批次](00-implementation-order.md#内置工具接入批次)。

本片分两阶段交付：第 2 批前台 Bash 已完成，第 7 批为 BgRun／BgOutput／BgStop。继续扩展当前 `xw-agent/src/run_loop.rs`，不再规划 runtime/agent_loop，不提前建立后台任务表或改成整套通用工具框架。

范围边界：已交付的前台 Bash 不包含后台参数、超时自动转后台、AskUserQuestion／RequestPermission 或新的执行策略设置。不修改用户沙箱／系统配置，不以裸 Command 替代旧版隔离方案；其他平台不宣称已经可用。

2026-10-25 第一阶段已完成实现、旧源码核对、自动／真实模型验证及产品窗口验收。迁移依据、行为与窗口／重启证据统一回填至 [Bash 交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#前台-bash-与-macos-沙箱2026-10-25)；已移除完成步骤，本文件仅保留第 7 批后台范围。

## 第二阶段：第 7 批后台工具

等第 6 批 WebFetch 完成后，再核对届时源码细化，不提前写入前台参数或会话任务状态：

- 在 runtime 的 Bash 目录扩展 BgRun／BgOutput／BgStop 和实际任务管理，保留旧输出游标／限额、最多 5 个后台 shell、进程组清理与退出语义；名称不再使用 BashOutput／KillBash。
- 根据后台任务真实所有权扩展 core 的 Session／service，Stop 清当前 Run 创建的任务，删除／退出清会话全部 shell，回收完成后释放 writer。
- 以真实子进程验证启动、增量输出、完成、停止、并发上限和关闭；历史 PID 重启后不得重连或重跑。后台副作用与 ResultUnknown 的边界复用既有持久事实，不另建自动恢复执行通道。

全部阶段完成后回填 record 并删除本 Plan，更新后继引用。生成产物走既有流程，不手改。
