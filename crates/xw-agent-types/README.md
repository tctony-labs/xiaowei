# Agent 内部领域类型

`xw-agent-types` 提供会话、输入、Run／Turn／Gen、消息、工具、Interaction、压缩及派生索引所需的领域类型，以及 JSONL v2 的前缀编解码与历史校验。所有公开类型和函数从包根导出，内部模块保持私有。生成请求／事件／安全错误及 ModelSelection／ModelInfo 同样从根入口导出，不包含异步 trait。客户端控制协议由共享 `contracts` 承载，本模块不提供 RPC、文件 I/O、运行调度或宿主生命周期。

写入单条记录使用 `encode_entry(entry, preceding_history)`，读取使用 `decode_entry(line, preceding_history)`；完整历史可用 `encode_history`／`decode_history`。换行、提交和文件恢复由 xw-agent-rollout 负责。两侧结合前缀重建归属和派生字段，并经 `validate_history` 检查身份、引用、消费关系和终态。合法的未完成前缀可以通过校验，恢复分类和结算属于上层。`validate_model_context(messages, capabilities)` 单独检查准备提交给模型的完整历史、工具配对和图片能力，不能以可序列化代替可回放。

`ModelDescriptor` 包含不透明模型引用、独立提供商／模型展示名称、可选 `ModelCapabilities` 和实际预算／来源。查询失败时能力保持未知，预算回退为 256_000／32_768；不保存配置 token。`InputModality` 表示模型支持的文本／图片输入种类，实际内容由 `ContentBlock` 保存。核心按能力检查输入与预算；API、provider 和上游模型的解析以及接口参数语义由宿主模型适配器负责。生成选项保留原值，本包检查通用结构、有限数值、预算和已知顶层敏感／覆盖字段，不枚举 provider 的参数或语法。适配器须在提供有效配置／选项时完成具体校验与非敏感字段筛选，不能把通过历史格式校验当作可以直接调用模型的证明。响应消息保留实际模型来源供追溯。

首条 SessionHeader 保存版本、会话身份和创建时间，第二条 Meta 保存初始模型选择；后续外层只保存 entry_id、timestamp_ms、payload，sequence 按文件顺序恢复。Meta 配置变化时追加，标题／归档管理在 SQLite；RunStarted 嵌入必要 RunContext，对话 Gen 继承，辅助 Gen 自带配置。通常省略未知可选值，实际结束时间未知等情况显式 null；未知字段、重复键、非法对象形状及未知 variant 严格拒绝。未知首条版本返回 UnsupportedVersion，只有当前格式 reader，不转换旧数据。嵌套 JSON 字符串、模型来源、签名、用量和单调耗时保留原值。完整格式见 record 的[历史格式](../../.agent/records/active/2026-09-28-agent-chat/history-format.md)。

生产依赖只有 serde／JSON、UUID 和安全错误支持。LLM PB 全字段转换及往返测试由 `xiaowei-agent` 提供；本包不依赖 contracts、ModelSettings、Storage、Gateway 或 napi。

```sh
cargo fmt -p xw-agent-types --check
cargo check -p xw-agent-types --locked
cargo test -p xw-agent-types --locked
cargo clippy -p xw-agent-types --all-targets --locked -- -D warnings
```
