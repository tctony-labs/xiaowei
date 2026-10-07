# 02k：中断继续与副作用保护

前置：[02f](02f-interactions.md)、[02g](02g-filesystem-tools.md)、[02h](02h-bash-sandbox.md)、[02j](02j-compaction.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：ContinueRun 从已提交边界恢复，不重复用户输入、已完成工具或未知结果副作用。

范围边界：不实现任意历史回退、fork 或自动重跑工具。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `contracts/proto/xiaowei/agent.proto` | 加入 ContinueRun Request／Response 与明确引用原 run／业务幂等 ID |
| 修改 | `crates/xw-agent/src/execution.rs、input.rs、interactive.rs、events.rs、persistence.rs`、`crates/xiaowei-agent/src/gateway.rs` | 继续用新运行关联原历史；明确结果未知／skipped，控制模型再次请求等价副作用 |
| 修改 | `crates/xw-agent/src/context.rs、recovery.rs` | 按持久工具意图／结果确定恢复分类，失效旧审批 |
| 消费（不修改 schema） | `crates/xw-agent-types/src/{rollout,context,interaction}.rs` | 使用 01a 的 RunCause::Continue／RunEnd、TurnEnded／GenEnded 的 Interrupted 结算、ToolOutcome／settled_by_run_id 及 ToolExecution 一次性确认，明确结算旧意图，不覆盖原记录 |
| 新增 | `crates/xw-agent/tests/continue.rs` | 工具批次中断、重启、幂等继续和重复副作用保护 |
| 修改 | `crates/xw-agent/tests/recovery.rs` | 恢复分类与闭合后的重开测试 |

## 实施顺序

1. 工具已完成则不再执行；意图已开始无结果追加“结果未知，未自动重试”的关联结果；未开始项补 skipped。
2. 新模型再次提出同名同参数的等价副作用必须经明确交互确认；不能借自动继续绕过。部分失败 assistant 不伪装成功。
3. Send／Continue／决定使用各自稳定业务 ID，重试不产生第二个 run；重启从不自动执行模型或工具；先将旧 Gen／Turn／Run 明确结算为中断，再开始 Continue Run；以 settled_by_run_id 归属新 Run 补旧工具的明确结果，配对闭合后才开始新 Turn／Gen。恢复补写 GenEnded 时结束时间未知，不伪造崩溃时刻，已提交首个 SSE 仍保留。

## 独立验收

- session／App Server 测试，经 typed Continue 验证实际临时文件副作用次数和子进程状态。
- 覆盖压缩后的上下文、已完成工具、未知工具结果、同参数重发、旧审批迟到、journal 失败与重复继续；正式 addon 重建。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
