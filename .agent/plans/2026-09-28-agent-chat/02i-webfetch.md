# 02i：WebFetch 与二次模型提取

前置：[02e](02e-tool-loop.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：网页读取、HTML 转 Markdown 和小文本模型提取能返回合法工具结果并继续运行。

范围边界：不加入 WebSearch、Wikipedia 或搜索服务配置。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-agent-runtime/src/tools/web/mod.rs、fetch.rs` | 迁移 URL／重定向／大小限制、内容分类、HTML 转 Markdown 与二次提取；用 01a 的 GenPurpose::ToolExtraction { tool_id } 标识调用，不新定义历史格式 |
| 修改 | `crates/xw-agent-runtime/Cargo.toml、src/tools/mod.rs`、`crates/xw-agent/src/context.rs` | 声明实际网页依赖和工具说明 |
| 修改 | `crates/xw-agent/src/model.rs、tool_registry.rs` | 通过 AgentHost 查询当次辅助引用、桥接内部生成接口给 WebFetch；传递取消，不读取 ModelSettings 或调用外部 PB client |
| 新增 | `crates/xw-agent-runtime/tests/webfetch.rs` | 本地 HTTP fixture + 确定性提取 provider 的网页边界测试 |
| 修改 | `Cargo.lock` | 由 Cargo 更新依赖 |

## 实施顺序

1. 核对旧 URL／响应大小／重定向规则，不直接沿用 deepseek/v4-flash；small_text 缺失返回明确工具错误。
2. 二次提取走同一领域 provider／Gen 计时与提交路径，使用自带必要 RunContext，run_id 与 ToolIntent 相同、turn_id=null；记录真实开始／首个 SSE／结束及原始用量。先结束提取 Gen，再提交 ToolOutcome；辅助 Assistant 不加入聊天历史，提取文本只进入工具结果。不把辅助 Gen 当作 Turn 最终对话 Gen、Conversation 尝试次数或聊天 context_tokens 测量。
3. 二次模型失败／取消形成工具结果；不影响普通聊天模型可用性，也不改变 LLM policy。已有辅助结果而工具结果未提交时保留恢复事实，不重新请求网页／模型。

## 独立验收

- 本地 HTTP 服务覆盖 HTML、透传文本、二进制、超限、非法 URL／重定向；fixture 使用符合真实 URL 校验的本地地址。
- 覆盖提取 Gen 归属与三个时间点、辅助 usage 只统计一次、提取失败／取消、GenEnded 后 ToolOutcome 前的恢复前缀，以及工具已结算后拒绝迟到提取事件。
- runtime／xw-agent 相关测试与格式／check，重建 Agent addon；不请求真实外部网页或模型。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
