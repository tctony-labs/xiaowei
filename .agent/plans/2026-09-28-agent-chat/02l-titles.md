# 02l：辅助标题 Gen 的持久记录

关联 [record](../../records/active/2026-09-28-agent-chat.md)、[标题行为](../../records/active/2026-09-28-agent-chat/runtime-ui.md#标题维护边界)与[总实施顺序](00-implementation-order.md)。

自动生成、主动重新生成及直接设置标题已经接入产品，标题与 auto_title_enabled 已由 SQLite 持久化。本片仅保留辅助 Gen 的历史记录，不把标题写回 Meta、不恢复 title_source 或从请求取得辅助引用的旧方案，不增加标题 Run／Turn。

## 文件与改动

| 类型 | 路径 | 剩余工作 |
| --- | --- | --- |
| 修改 | `crates/xw-agent/src/{title,persistence,recovery,session}.rs` | 为 GenPurpose::Title 持久提交开始／真实首 SSE／结束及独立 usage；使用无 run／turn 归属的辅助配置，串行处理与聊天写入竞争及关闭结算 |
| 修改 | `crates/xw-agent/tests/{titles,recovery}.rs` | 验证辅助 Gen 合法前缀、中断重开、独立用量及不混入聊天历史；保留标题竞争／删除／关闭回归 |
| 修改 | `crates/xiaowei-agent/napi/test/sessions.test.cjs` | 正式入口验证标题记录与重开，标题仍只存 SQLite |

## 顺序与验证

1. 复用当次 AgentHost.get_auxiliary_model_ref 和唯一生成流；辅助 Gen 自带必要配置，不占聊天 max_gens 或上下文测量，未知首 SSE／实际结束时间保持未知。
2. 在当前任务身份、会话串行写入与取消边界内提交记录；失败不改变聊天终态、不覆盖原标题，文件不可写必须阻止继续写并沿现有 NeedsCheck 路径处理。
3. 通过相关 Rust、正式 addon、格式／历史校验和 just check。验证聊天与标题并发、部分前缀／恢复、usage 只计一次、手动改名和删除不会被旧结果覆盖。

完成后回填辅助调用持久语义并删除计划，不重复实施已交付标题 UI。
