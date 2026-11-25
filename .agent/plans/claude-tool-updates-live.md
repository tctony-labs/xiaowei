# Claude Messages 工具变更真实端点验收

关联 [Agent Chat 模型适配历史](../records/archived/2026-09-28-agent-chat/model-types.md#工具变化的模型适配2026-11-20)。Claude Messages 已通过实际 SDK 请求编码测试。2026-11-25 确认暂缓真实端点验收，恢复条件是有可用端点、有效凭据及确认支持会话中途工具变更的模型。

1. 在隔离测试配置中选择上述模型并启用 `compat.supportsMidConvoToolChanges`。复用 [LLM worker 的工具变更探针](../../desktop/tests/llm/harness-context.test.mjs)，用无副作用的探针工具。
2. 对同一历史依次验证新增、停用和同名 schema 替换。检查实际请求中的 `tool_addition`／`tool_removal`，记录端点状态及最终回复。
3. 验收条件为新增工具可调用、停用工具无调用、同名替换使用新参数。只记录请求结构和结果，凭据留在测试配置加载链路内。
4. 回填 [桌面模型适配验证说明](../../desktop/scripts/README.md)，然后删除本计划。
