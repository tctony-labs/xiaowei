# 02e：工具循环与有序结果

前置：[当前文本聊天基线](../../records/active/2026-09-28-agent-chat/implementation-results.md#持久文本聊天里程碑)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：Agent runtime 能处理工具声明、合法 TOOL_USE、顺序执行和结果闭合后继续模型生成。

范围边界：测试工具仅验证循环；文件、Bash、WebFetch 和用户交互由后续各片真实交付。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `crates/xw-agent-runtime/src/text.rs、generation.rs` | 加入当前需要的工具接口、循环和限额；不依赖 Gateway |
| 新增 | `crates/xw-agent-runtime/src/agent_loop/{mod,run,tool_execution}.rs` | 迁移旧循环并接现有文本生成；顺序工具执行、参数错误与取消结果闭合 |
| 新增 | `crates/xw-agent-runtime/src/tools/mod.rs、tool_params.rs、ui_description.rs` | 工具注册接口、JSON 参数校验与实际 UI 描述 |
| 新增 | `crates/xw-agent/tests/tool_loop.rs` | App Server 下的工具 Item 关联／变化测试 |
| 新增 | `crates/xw-agent-runtime/tests/tools.rs` | 确定性工具循环、非法参数、上限和取消测试 |
| 新增 | `crates/xw-agent/src/tool_registry.rs` | 装配实际工具接口；本片生产注册为空，不发布测试工具 |
| 修改 | `crates/xw-agent/src/execution.rs、events.rs、persistence.rs、recovery.rs`、`crates/xiaowei-agent/src/gateway.rs` | 工具事件转公共 Item 视图，保持 Run／Turn／Gen／provider call ID 关联，Gen 结束后工具 pending 时继续保持 Turn 活动 |
| 修改 | `contracts/proto/xiaowei/agent.proto` | 加入实际工具公共视图；内部意图／结果直接消费 01a 的 ToolIntent／ToolOutcome／ProviderToolKey，保留 metadata／usage，复用当前领域类型与 compact codec |

## 实施顺序

1. 核对旧顺序工具执行及默认每 Run 50 次限制；仅完整有效 TOOL_USE 才执行，LENGTH 不执行截断参数。
2. 未知工具、参数错误、执行失败返回关联错误结果；取消结算已完成结果和未执行项，禁止停止后下一次 Generate。
3. 模型 TOOL_USE 完整结束时先结算 Gen，工具结果闭合后才结算 Turn，后续生成另开 Turn；不把一次 TOOL_USE 当 Run 完成；工具参数 delta 与最终参数分开，耗时缺失不伪造零值。

## 独立验收

- runtime／xw-agent 工具测试及相关格式／check；契约生成和漂移检查。
- 确定性 provider + 有真实临时副作用的测试工具验证 call → result → 下一次模型调用、顺序、50 次边界、GenEnded 后 Turn 工具 pending、工具结果提交后 TurnEnded 和各阶段取消。后续 steering 的工具间检查／skipped 闭合规则已在 01a 定义，本片不实现排队入口。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
