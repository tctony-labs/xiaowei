# xw-agent-runtime

提供 Agent 内部生成执行边界与单次文本执行，独立于 App Server 公共协议、Gateway、napi 和具体 LLM provider。生成请求／事件／错误、消息、身份和用量复用 `xw-agent-types`；对外统一 AgentHost 定义于 xw-agent，核心将其桥接为本包内部 LlmGeneration。

包根导出 `LlmGeneration`、`GenerationRequest`、`GenerationEvent`、`GenerationError`、异步流／future 别名和取消 token。实现方必须在开流与消费阶段响应取消，并在 future／stream 被释放时取消上游工作。错误不得携带原始响应正文或凭据。

`execute_text` 使用 App Server 提供的身份，单次调用 generate 并返回唯一 RunOutcome。内部 RunEvent 通过有界 channel 传递增量；取消覆盖开流、读取和发送等待。完整 STOP／LENGTH 消息用于成功结果，部分显示不作为模型历史。记录 Gen 开始／结束和单调耗时；来源未提供首 SSE 时间时保持 None。实际 LLM adapter 由集成层提供，不增加通用 `types.rs`。

`complete_text` 供标题等辅助任务消费同一生成流，只返回通过校验的完整成功 AssistantMessage，不向聊天投影发送增量；开流、读取、失败与取消沿用同一生成边界。调用方提供模型引用、指令和生成选项，并拥有任务超时与业务结果的提交。

```sh
cargo test -p xw-agent-runtime --locked
```
