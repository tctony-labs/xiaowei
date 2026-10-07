# 02j：上下文预算与自动压缩

前置：[02e](02e-tool-loop.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：超过预算时按旧算法生成并提交压缩检查点，工具配对与原始历史保持完整。

范围边界：不引入新压缩产品设置，不实现 rewind／fork。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-agent-runtime/src/context_budget.rs、compact.rs` | 迁移预算与 prepare／commit 压缩阶段，适配 Pi token／模型能力 |
| 修改 | `crates/xw-agent-runtime/src/lib.rs、text.rs、agent_loop/run.rs` | 已结算 Turn 之间的预算、压缩和取消检查；压缩不使用工具 |
| 修改 | `crates/xw-agent/src/execution.rs、events.rs、persistence.rs、recovery.rs` | 通过注入领域 provider 生成，提交检查点后再切上下文，发布真实压缩状态／错误；外部 PB adapter 留在 xiaowei-agent |
| 修改 | `crates/xw-agent/src/context.rs` | 消费 01a 已定的 Compacted 边界／替换前缀／保留后缀／来源字段，确保指定历史边界可重建，不到本片再补 schema |
| 新增 | `crates/xw-agent-runtime/tests/compaction.rs` | 预算边界、失败／取消／空摘要／超限与 commit 顺序 |
| 修改 | `crates/xw-agent/tests/recovery.rs`、`crates/xw-agent/tests/compaction.rs`（新增） | 压缩前后重开、写入失败和完整原历史可读 |

## 实施顺序

1. 使用 01a 的 GenPurpose::Compaction，无聊天 Turn 归属；在 Run 前或已结束且工具闭合的 Turn 之间采样，Gen／usage 独立记录。采用旧算法、本 Run 固定的模型选择与预算，不引入 configuration token。Host 模型信息获取失败时，按[统一 Host 契约](../../records/active/2026-09-28-agent-chat/host-interface.md#统一-host-注入契约)回退到 256_000 tokens（256K）并保留预算来源；可能改变压缩触发时机，不因此禁止按原引用生成。保留 input／cache token 口径，不静默丢历史。压缩 Gen 不占 max_gens 的 Conversation 次数，实测 usage 只记一次；checkpoint 提交使旧聊天测量 stale，不以辅助 Gen 的 context_tokens 或 tokens_before 冒充压缩后聊天预算。
2. checkpoint 提交成功才替换有效上下文；空摘要、写入失败、取消或仍超限保留原历史并明确结束，不循环压缩。

## 独立验收

- runtime／session／App Server 相关测试与 addon 构建。
- 确定性长上下文及存储失败注入验证 prepare → 持久 commit → 生效顺序；原始历史分页仍可读。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
