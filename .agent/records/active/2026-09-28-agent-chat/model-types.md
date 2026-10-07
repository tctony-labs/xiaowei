# 领域消息与模型上下文

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。本文是同一 record 的专题附件，状态与范围由主 record 管理。

本文描述当前 types 与模型上下文边界：独立展示名称、可选能力、预算来源与生成纯数据；模型选择通过独立 Meta 提交。详见[统一 Host](host-interface.md#统一-host-注入契约)与[历史格式](history-format.md)。

Host 注入接口为 xw-agent 的单个 AgentHost trait，含 generate／get_model_info／get_auxiliary_model_ref。生成请求、事件、错误及模型选择／说明等领域数据迁入 types；异步接口别名归 xw-agent，runtime 不反向依赖核心。模型说明获取失败不阻止继续使用原引用生成，预算回退及首 SSE 事件按[统一 Host 契约](host-interface.md#统一-host-注入契约)处理。下方字段表描述当前代码，持久表示的省略／重建规则见历史格式。

## 领域消息与 LLM 转换（已验证的子范围）

包名已按用户要求统一为 `xw-agent-types`，用于明确内部领域类型与公共 RPC 契约的区别。01a 已将 PB bridge 迁出生产入口，纯领域消息与当前历史格式不依赖外部业务模块。

`crates/xw-agent-types` 现已提供 serde 领域消息、完整 rollout 类型及精简读写／校验入口，由当前 runtime／App Server／rollout 使用；不是客户端控制协议。当前 LLM PB 双向转换已迁入 xiaowei-agent/src/message_codec.rs 的生产 adapter，并移除测试 support 和 types 的 contracts dev-dependency；文件管理归 xw-agent-rollout，业务恢复及 SQLite 会话管理归 xw-agent。user／assistant／tool-result 分开建模，有序文本、图片、thinking、tool-call 内容块保留全部已知字段，包括签名、redacted、模型来源、原始时间戳、工具关联、usage 与 optional 缺失／存在的差别。

嵌套 arguments／details JSON 保留原始字符串，转换时校验语法，arguments 存在时须为对象；未完成流式 tool-call 可保留缺失参数，但不表示已具备模型请求合法性。未知 finish reason、缺失 oneof、非法 JSON 和非有限／负费用显式返回安全字段诊断，不回显消息或参数。JSON 的费用值禁止静默变成 null，Rust serde 保留 i64／u64 与有限 f64 精度；费用和 token total 不重新计算。范围仅包含当前 prost schema 的已知字段，不承诺保存解码时已被 prost 丢弃的未知 wire 字段。

迁移核对旧版 `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` 的 `message.rs`：沿用领域历史与外部模型类型分离的思路；旧版 user 内含工具结果、转换时调用 Utc::now 的行为已按当前契约适配为独立 tool-result 与原始 timestamp_ms。旧 Attachment／Skills 和 xw-llm 依赖不迁入，本期无旧数据导入。

## 当前类型与历史格式（01a 与文件层已交付）

本文与[历史格式](history-format.md)共同描述当前领域类型与 v2 磁盘表示。文本持久化已接生产；首期工具、交互、压缩和继续运行的结构已有定义及 fixture 校验，实际执行仍由后续切片实现。types 是内部领域包，公共 Request／Response／Event 在 agent.proto。

### 源码基线与采用范围

| 来源 | 核对文件／实体 | 本次采用与限制 |
| --- | --- | --- |
| 旧 Rust `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` | `crates/xw-agent-protocol/src/{message,rollout}.rs`；`xw-agent-session/src/{lib,local}.rs`；`xw-agent-app/src/interactive.rs` | 迁移消息、JSONL、工具记录、预算和压缩语义；保留 JSONL 语义，SQLite 由 xw-agent 自管，旧格式不导入 |
| 当前 XiaoWei | `contracts/proto/xiaowei/llm.proto`；`desktop/src/main/services/llm/worker/{messages,events}.ts` | 以实际 PB 字段和 worker 校验为模型边界，不能把“可序列化”当成“可用于 Generate” |
| Codex `b741e480e203f037ca726bc2a76d99a8e8668e66` | `codex-rs/history/src/lib.rs` 的 `ResponseItemEnvelope`／`RolloutItem`／`RolloutLine`；`protocol/src/{models,protocol}.rs` 的 `ResponseItem`／`SessionMeta`／`TurnContextItem`；App Server 的 `ThreadItem`／`TurnSteerParams` | 采用稳定实体身份、历史顺序、配置归属和输入目标边界；不复制 OpenAI 专有 ResponseItem 联合或宣称 wire 兼容 |
| 已安装 Pi AI `0.87.1` | `desktop/node_modules/@earendil-works/pi-ai/dist/types.d.ts` | 当前模型实际消费基线；SystemMessage、deferred、diagnostics 等上游字段不等于本项目已支持 |
| Pi 最新参考 `11449730c8a733953ce1bcce70e066bccaa778a5` | `packages/agent/src/types.ts`；`packages/coding-agent/src/core/session-manager.ts` 的 `SessionHeader`／`SessionEntryBase`／`CompactionEntry` | 采用模型历史转换与运行状态分离、压缩边界／来源；不提前建设分支 DAG 或迁入 TS Agent |

### 内存上下文与最小持久信息

**完整 RuntimeRunContext 在内存中组装，不整体持久化。** 消息和工具结果从历史重建；权限从已提交决定重建；系统指令使用当前 host 注入值，工具声明及调用参数从 RunContext 取得。取消句柄、provider／工具实例、连接、队列对象、缓存和进程句柄只在内存中，恢复时重新创建。重放指重建状态，绝不重新执行历史模型或工具。

`RunContext` 嵌在 RunStarted 中，Conversation Gen 继承所属 Run；辅助标题／压缩／工具提取 Gen 携带自己的必要配置。没有独立 ContextDefined、ContextId 或跨 Run 配置去重，不保存完整系统指令和外部设置。完整内存上下文由历史和这些必要参数组装。

Run 只锁定 Agent 选择的 model_ref／reasoning 与 Agent 自己的运行配置；不检测 LM worker 中同引用的配置变化，原配置 token 设计已撤回。Meta 与 Run 配置分别保存 host 提供的 provider_name／model_name（例如 tctony 与 sol），使历史展示独立于当前模型列表；不保存预先拼接的名称，只在最终展示层格式化。凭据、认证 headers、带凭据的连接地址和完整 ModelConfiguration 不落盘；provider 默认值若当前接口未暴露，保持未显式指定。这套格式用于恢复领域历史与说明当时的选择，不承诺重新发送完全相同的 HTTP 请求。

### 当前消息字段逐项对齐

下表的领域目标是 src/message.rs；当前 PB 转换在 xiaowei-agent/src/message_codec.rs，types 的 xw-contracts 依赖及 TryFrom 出口已移除。字段与原无损往返不变，不为存储 schema 改写 LLM 契约。

| 领域实体／字段 | 当前 PB 对应 | Pi／旧版对齐与处理 |
| --- | --- | --- |
| `AgentMessage::{User,Assistant,ToolResult}` | `ChatMessage.message` 三种 oneof | Pi 三种模型历史角色；旧 User 内嵌工具结果改为独立 ToolResult |
| `UserMessage.content, timestamp_ms` | `UserMessage.content, timestamp_ms` | Pi content／timestamp；保留原时间，不沿用旧转换时 Utc::now |
| `AssistantMessage.content, api, provider, model_id` | 同名字段 | Pi content／api／provider／model；来源不可由当前模型补猜 |
| `AssistantMessage.usage, stop_reason, timestamp_ms` | 同名字段 | Pi usage／stopReason／timestamp；允许 codec 保存缺失／部分值，回放另校验 |
| `AssistantMessage.response_id, response_model, provider_thinking_level, raw_stop_reason, end_turn` | 五个同名 optional | 保留 presence；worker 没传出的上游诊断不能由 journal 自行捕获 |
| `ToolResultMessage.tool_call_id, tool_name, content, is_error, timestamp_ms` | 五个同名字段 | Pi toolCallId／toolName／content／isError／timestamp；不与业务 ToolId 混用 |
| `ToolResultMessage.details_json, added_tool_names, usage` | 三个同名字段 | details 原始 JSON 字符串；保留当前 PB 已支持字段，不能因所装 Pi 类型缺项删除 |
| `ContentBlock::Text.text, signature` | `TextContent.text, signature` | textSignature 是不透明签名，包含 phase 时也不解析后重写 |
| `ContentBlock::Image.mime_type, data` | `ImageContent.mime_type, data` | 图片字节完整保存；本期不开放图片输入 UI |
| `ContentBlock::Thinking.text, signature, redacted` | `ThinkingContent` 三字段 | thinking／thinkingSignature／redacted；签名不作为可见正文 |
| `ContentBlock::ToolCall.id, name, arguments_json, thought_signature, namespace` | `ToolCallContent` 五字段 | final arguments 保留原字符串／对象语义；缺失只能表示尚未完整，不可执行 |
| `FinishReason` 六个值 | 当前六个 PB 枚举 | Unspecified／Stop／Length／ToolUse／Error／Aborted 全覆盖；不自动加入上游 pending／deferred |
| `TokenUsage.input, output, cache_read, cache_write, total` | 五个同名 uint64 | 按 provider 原口径保存，不重算 total，0 不自动解释成测量为零 |
| `TokenUsage.reasoning, cache_write_1h, cost` | 三个 optional／message | 缺失与显式 0 分开；assistant 的有效回放要求 usage.cost 存在；tool result 可无 usage，但提供 usage 时同样须有 cost |
| `UsageCost.input, output, cache_read, cache_write, total` | 五个同名 double | 有限且非负；原值往返，不重算总费用 |

Pi 的 `SystemMessage.sections/toolsAdded/toolsRemoved`、custom agent message、deferred handle、diagnostics、raw errorMessage，以及 Codex encrypted reasoning／专有响应项不是当前 LLM PB 支持的模型历史。系统指令由 host 当前注入，工具声明及必要执行参数由 `RunContext` 表达；安全失败说明由 `GenEnded`／`TurnEnded`／`RunEnd` 表达；其他能力明确后续处理，不能用任意 AppEvent blob 假装已经支持。

### 文件与 Rust 类型职责

以下为 01a 实际文件。主要上下文字段在下文说明，磁盘字段统一见历史格式；运行时事件、公共 DTO 不加入此存储联合。

| 目标文件 | 类型与边界 |
| --- | --- |
| `crates/xw-agent-types/src/ids.rs` | SessionId／EntryId／InputId／RunId／TurnId／GenId／MessageId／BlockId／ToolId／InteractionId／ClientRequestId 的独立 newtype，UUIDv7 文本编码；Sequence／MetadataRevision 为独立 u64 计数类型 |
| `src/rollout.rs` | JournalEntry／EntryPayload（含无 data 的 SessionHeader）、SessionMeta、输入接纳／消费／取消、RunStarted、TurnStarted／Ended、GenStarted／FirstSseReceived／Ended、RecordedMessage、ToolIntent／Outcome、Compacted、RunEnd、SessionSummary／ContextBudgetSnapshot、DeletionMarker |
| `src/context.rs` | RunContext、ModelDescriptor／ModelCapabilities／InputModality、GenerationParameters、ToolDeclaration、RuntimeLimits、InputSource、InputMode、ContextBoundary、RunCause、ExecutionPolicy；没有运行句柄或完整历史 |
| `src/interaction.rs` | InteractionOpened／Resolved／Expired、InteractionRequest／Answer、PermissionTarget；没有 observer／delivery 或接收回执 |
| `src/format.rs` | v2 精简序列化／解析入口、版本探测与 FormatError；区别于 PB codec，不处理文件 I/O；错误 path 只含已知 schema 字段与索引 |
| `src/validation.rs` | 单记录结构校验、记录间引用／状态校验、有效模型上下文与模型能力校验；导出 ValidationError／ValidationCode，不给错误附带消息正文 |
| `src/generation.rs` | GenerationRequest／GenerationEvent／GenerationError，含真实 FirstSseReceived；纯数据，不引入异步依赖 |
| `src/model.rs` | ModelSelection／ModelInfo、模型及辅助引用查询错误、默认预算常量 |
| 现有 `src/message.rs` | 完整领域消息；PB bridge 已移出生产 types，正式转换位于 xiaowei-agent/src/message_codec.rs |

### 随 Run 保存的必要上下文

| 类型 | 全部字段 | 语义／不变量 |
| --- | --- | --- |
| `RunContext` | `model: ModelDescriptor`、`generation: GenerationParameters`、`tools: Vec<ToolDeclaration>`、`limits: RuntimeLimits` | 嵌在 RunStarted 中且该 Run 内不变；Conversation Gen 继承，辅助 Gen 自带必要配置。系统指令每次使用 host 注入值，不另存定义记录或跨 Run 配置引用；权限从历史重建 |
| `ModelDescriptor` | `model_ref: String`、`provider_name: String?`、`model_name: String?`、`capabilities: ModelCapabilities?`、`budget: ModelBudget` | ref 为不透明调用身份，名称只展示；查询失败能力为 None（磁盘省略），预算记录实际 Default 回退，不含配置 token |
| `ModelBudget` | `context_window: u64`、`max_output_tokens: u64`、`source: BudgetSource` | Host 或 Default；默认 256_000／32_768，恢复不改写历史值 |
| `ModelCapabilities` | `input_modalities: Vec<InputModality>`、`supports_reasoning: bool`、`context_window: u64`、`max_output_tokens: u64` | 核心所需的输入能力、推理能力和预算；输入种类非空且不重复，预算为 JS safe 正整数、输出上限不超过上下文窗口 |
| `InputModality` | Text／Image | 只声明接受哪种输入，不携带内容；正文／图片实际数据保存在 ContentBlock |
| `GenerationParameters` | `temperature: f64?`、`max_tokens: u32?`、`reasoning: String?`、`thinking_budgets_json: String?`、`tool_choice_json: String?`、`sampling_params_json: String?`、`cache_retention: String?`、`provider_session_id: String?`、`transport: String?`、`timeout_ms: u32?`、`websocket_connect_timeout_ms: u32?`、`metadata_json: String?`、`api_options_json: String?` | 对齐 GenerateRequest 的两个参数及 GenerationOptions 全字段；provider_session_id 对应 options.session_id，避免混淆业务 SessionId；None=不显式指定（磁盘省略）。JSON 保留原字符串；types 只校验通用结构、有限数字、输出预算、推理能力和已知顶层敏感／覆盖字段。温度范围、推理档位、传输、接口选项及参数冲突由宿主模型适配层校验；未指定为 None（磁盘省略） |
| `ToolDeclaration` | `name: String`、`description: String`、`parameters_json: String`、`constrained_sampling_json: String?` | 对齐 ToolDefinition 四字段；工具名在定义内唯一，schema 为 JSON object；constrained_sampling_json 仅检查 false／object 结构，具体约束语法由模型适配层校验；不保存工具实例 |
| `RuntimeLimits` | `max_gens: u32?`、`max_tool_calls: u32` | 按 Run 累计，steering 不重置，新 follow-up Run 重新计算；None 代表无额外 Gen 次数限制，不臆造旧版限制；工具默认 50，实际使用值保存。max_gens 只计本 Run 的 Conversation GenStarted，每次尝试（含失败／取消／抢占）均计一次；Compaction／Title／ToolExtraction 不占此次数。所有 Gen 用量按其身份独立归属，不重复累计 |
| `ExecutionPolicy` | Interactive／UnattendedWorkspace／Unrestricted | 沿用旧 Rust 含义；默认可写范围由宿主的自有 workspace、/tmp、~/tmp 规则得到，扩展写权限由持久审批决定得到 |

RunContext 不建立跨 Run 配置去重。它只保存重建所需的执行信息，不保存会话历史、context budget 缓存、授权路径列表或运行句柄。生成参数中的 JSON 字符串保留原值；模型预算在磁盘只保存一份，capabilities 的同名窗口／输出字段从 budget 恢复。历史消息自带的实际 api/provider/model/usage 是响应事实，不能被请求配置覆盖。

模型描述与模型接入知识分离：RunContext 保存 Agent 决策所需的引用、能力及有效参数，不重复保存 API／provider／上游模型路由字段。实际响应来源仍由 AssistantMessage 保留；未取得响应时不从当前配置补猜来源。生成参数与工具约束的具体接口语义由宿主模型适配层在提供有效配置／选项时验证并筛选可持久化的非敏感字段，实际调用继续经 provider／worker 校验；通过 types 的格式校验不等于可以直接发送到具体接口。types 的已知顶层敏感字段拒绝只是基础防线，不能代替适配器的完整筛选。恢复重建配置引用与决策上下文；显式 Continue 获取新的宿主输入，同 Run 固定引用与思考强度，不检查模型层配置版本。
