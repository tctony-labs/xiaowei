# 02j：上下文预算与自动压缩

前置：[已交付的工具循环](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：超过预算时按旧算法生成并提交压缩检查点，工具配对与原始历史保持完整。

范围边界：不引入新压缩产品设置，不实现 rewind／fork。承接 [Harness 能力上下文同步](../../records/active/2026-09-28-agent-chat/model-types.md#harness-能力上下文同步)，新上下文需重新建立当前指令／工具的完整基线。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-agent-runtime/src/context_budget.rs、compact.rs` | 迁移预算与 prepare／commit 压缩阶段，适配 Pi token／模型能力 |
| 修改 | `crates/xw-agent-runtime/src/lib.rs、text.rs、agent_loop/run.rs` | 已结算 Turn 之间的预算、压缩和取消检查；压缩不使用工具 |
| 修改 | `crates/xw-agent/src/execution.rs、events.rs、persistence.rs、recovery.rs` | 通过注入领域 provider 生成，提交检查点后再切上下文，发布真实压缩状态／错误；外部 PB adapter 留在 xiaowei-agent |
| 修改 | `crates/xw-agent/src/context.rs` | 消费 01a 已定的 Compacted 边界／替换前缀／保留后缀／来源字段，确保指定历史边界可重建；利用 02e 系统上下文记录在压缩后重建一份当前完整基线，后续仅追加变化 |
| 新增 | `crates/xw-agent-runtime/tests/compaction.rs` | 预算边界、失败／取消／空摘要／超限与 commit 顺序 |
| 修改 | `crates/xw-agent/tests/recovery.rs`、`crates/xw-agent/tests/compaction.rs`（新增） | 压缩前后重开、写入失败和完整原历史可读 |

## 实施顺序

1. 使用 01a 的 GenPurpose::Compaction，无聊天 Turn 归属；在 Run 前或已结束且工具闭合的 Turn 之间采样，Gen／usage 独立记录。采用旧算法、本 Run 固定的模型选择与预算，不引入 configuration token。Host 模型信息获取失败时，按[统一 Host 契约](../../records/active/2026-09-28-agent-chat/host-interface.md#统一-host-注入契约)回退到 256_000 tokens（256K）并保留预算来源；可能改变压缩触发时机，不因此禁止按原引用生成。保留 input／cache token 口径，不静默丢历史。压缩 Gen 不占 max_gens 的 Conversation 次数，实测 usage 只记一次；checkpoint 提交使旧聊天测量 stale，不以辅助 Gen 的 context_tokens 或 tokens_before 冒充压缩后聊天预算。
2. 用权威当前指令／工具状态建立新上下文基线，不能仅依赖模型摘要保存工具 schema，也不把旧基线与全部增量一起复制进新上下文。checkpoint 与新基线一致提交后才替换上下文和同步状态；提交失败保留旧状态。
3. checkpoint 提交成功才替换有效上下文；空摘要、写入失败、取消或仍超限保留原历史并明确结束，不循环压缩。

## 独立验收

- runtime／session／App Server 相关测试与 addon 构建。
- 确定性长上下文及存储失败注入验证 prepare → 持久 commit → 生效顺序；原始历史分页仍可读。
- 有工具增删／定义变化的历史压缩后，新的有效上下文只有一份当前完整基线；下次未变化不再追加，下一次变更只写增量；压缩失败和重开后基线仍可正确恢复。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
