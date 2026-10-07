# 基于 Pi 的 LLM provider

## Why

Quick Chat 后续需要模型调用、流式事件、工具、取消和推理内容。用户决定复用成熟的 Pi 模型调用库，并希望通过现有 Gateway 让 TypeScript 的模型生态与 Rust 的 agent／会话能力协作，而不是迁入旧版 `xw-llm` 的自有 HTTP、SSE 和 WebSocket 实现。

## What

建立可供 Agent／Quick Chat 使用的 Pi provider 边界。最终需能按当前设置选择模型和凭据，处理请求、流式文本／推理／工具调用、使用量、结束／错误与取消，并经 Gateway 供 Rust agent 调用。已交付 Gateway worker 通信、Pi 补丁、完整生成与模型目录、持久模型设置及 Responses WebSocket。LLM service 在 Node worker 内运行；Agent 产品调用另由 Agent Chat 事项维护。

本事项不接入 Quick Chat 产品 UI，不改变会话数据，也不以直接模型调用代替旧 agent 的工具与恢复语义。UI 入口预览另见 [Quick Chat UI 事项](2026-09-24-quick-chat-ui-interaction.md)。

## How

旧版源码位于 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，本轮核对 HEAD `6be131098d0b907b988f7f53460f450c89b9034c`。旧 `xw-agent-runtime` 通过 Rust `ChatProvider::stream` 接收 `ChatRequest`、`StreamEvent`，`xw-agent-protocol`／rollout 也复用 `xw-llm::types`。采用 Pi 后需保留必要的领域数据语义，并建立 Rust↔TS 适配；不能直接把 TypeScript 库实现为 Rust trait。

当前 Gateway 已支持 TypeScript owner、Rust caller 和响应流，LLM 业务契约见 `contracts/proto/xiaowei/llm.proto`。main 的目录规则和现有文件归属维护在 [Electron main 模块组织](../../../desktop/src/main/README.md)。Pi provider 位于 `desktop/src/main/services/llm/`，由 `app/gateway.ts` 装配和关闭；本阶段不新增 Rust crate 或 npm workspace package。Rust typed caller 已通过 Gateway 验证交错的文本／推理／工具块、工具参数 JSON、取消及用量；产品文本 Agent 已通过 xiaowei-agent 接入，工具循环仍未交付，见[Agent Chat](2026-09-28-agent-chat.md)。

`@mariozechner/pi-ai` 与 `@earendil-works/pi-ai` 是同一 Pi 项目的旧／新发布名，并非两个并行分支：旧 GitHub 地址 `badlogic/pi-mono` 重定向到 `earendil-works/pi`，两个地址当前指向同一提交；旧 npm 包已标记弃用并提示改用新包。后续使用 `@earendil-works/pi-ai`。用户给出的本地 DSH `/Users/changtang/Develop/LLM/deepseek-harness` 已使用新包（更新后锁定 0.85.1，并携带工具参数流式解析补丁），其 `packages/llm/llm-pi-ai/` 是 DSH 自己的适配层，可参考 `src/context.ts`、`stream.ts`、`provider.ts` 的映射，不复制 Cordis、凭据或会话系统。本项目当前在 desktop 固定使用 `@earendil-works/pi-ai@0.87.1`，并登记同版本 pnpm 补丁；升级结论见下节。

设置模型页已接真实提供方配置、Key、远端目录与持久化；Storybook 保留纯展示预览。Pi 的协议名与设置页的 `openai-completions`、`openai-responses`、`anthropic-messages` 一致，但能力、上下文上限和输出上限需有明确来源。旧版与 Pi 在重试、Responses WebSocket、推理回放和错误细节上的差异要逐项验证并记录。

### Pi 与 DSH 参考边界

当前 desktop 精确依赖 @earendil-works/pi-ai 0.87.1，pnpm patch 固定工具参数流式解析及通用 Responses WebSocket 修改；维护见[patches README](../../../patches/README.md)。normalizeContext 合并 system 与工具声明后传 TranscriptContext，JsonValue／JsonObject 的对象校验在适配层。原 @mariozechner 包已更名，不是另一套 Agent 实现。

DSH 的源码参考基线为 `46a7f68b0922371ce7144b668b90e377d8e799f4`，当时锁定 Pi 0.85.1。其 packages/llm/llm-pi-ai 是额外适配层，冻结配置、解析认证、关闭 SDK 重试并转换消息／回放，不应将这些策略当成 Pi 自带能力。其工具参数补丁删除六处对累计 JSON 的重复解析，仅保留 delta 和终态参数，避免大参数的重复解析开销；XiaoWei 已重基到当前版本，以 Completions／Responses 本地 SSE 回归验证，其他补丁路径的覆盖限制见 Outcome。

当前使用 Pi 公共 api 窄入口，类型只留在 LLM 适配模块；不复制 DSH 的 Cordis、认证或会话系统。静态目录／预设是能力来源，缺省预算不是目录上限。推理档位以 thinkingLevelMap 为准，不自行增加 ultra 或将 max 统一映射为 xhigh。

### 请求映射与旧版差异

旧 Quick Chat 的 `xiaowei/src-tauri/src/biz/quick_chat/commands.rs::quick_chat_send` 经 Studio `bridge/quick_chat.rs::send_message` 委托 chat；模型请求由 `crates/xw-agent-runtime/src/agent_loop/sampling.rs` 构造。动态 system prompt、工具定义、历史、会话和工具循环属于 Rust agent，而非 Pi provider。以下以旧 `crates/xw-llm/src/types.rs`、`remote_provider/resolver.rs` 和 DSH 对应适配文件为依据。

| 旧请求／配置 | Pi 对应 | 转换与差异 |
| --- | --- | --- |
| `system_prompt`（已合并动态片段） | `Context.systemPrompt` | 按请求传入。Pi 消息 union 没有 system role；DSH 仅在无显式 system 时提取首条 system，其余降为 user。XiaoWei 不照搬这种角色降级：当前接受独立 system prompt；历史 system 的迁移另行显式处理。 |
| user 的 Text／Image、timestamp | `UserMessage`，text／image，`mimeType`、原始 base64 | 保留内容顺序与毫秒时间戳；图片要求模型 `input` 包含 image。DSH 另做附件读取、缩放、预算与卸载，不能当成 Pi 自带文件生命周期。本片不迁移附件系统。 |
| assistant 的 Text／ToolCall | `AssistantMessage.content` 的 text／toolCall | 工具 `id/name/arguments` 对应；Pi arguments 为对象，边界须验证。Pi 历史还需要来源 `api/provider/model`、usage、stopReason、timestamp；旧消息没有完整来源，不能用当前模型伪造历史来源。无原生回放信息时只能明确作为降级历史。assistant image 无对应，须拒绝。 |
| `reasoning_content/signature/items` | thinking 块、`thinkingSignature`，及响应来源元数据 | 不能仅拼接推理字符串；需按块保存回放，见下文。旧数据转换不属于最小调用。 |
| ToolResult：`tool_call_id/tool_name/is_error/content` | `ToolResultMessage`：`toolCallId/toolName/isError/content` | 保留文本／图片与调用关联；缺失名称可由对应历史 toolCall 查得，不能丢掉关联。工具执行、权限和恢复归 Rust。 |
| `ToolDef.parameters_schema` | `Context.tools[].parameters`（JSON Schema／TypeBox 结构） | name／description 原样；provider 只声明工具，不执行工具。旧 agent 对 schema 的 UI description 增补仍在 Rust。 |
| 逻辑模型 ID、ProviderConfig | `Model.api/provider/id/baseUrl`，provider auth 与请求 headers | 旧 `openai/anthropic/responses` 对应 `openai-completions/anthropic-messages/openai-responses`。旧 `provider/upstream` 和 DeepSeek 历史别名先解析为明确路由及上游 ID，不能把整串直接作为 Pi model.id；设置模型使用持久化的本地模型 ID 作为引用。 |
| 模型能力 | `reasoning/input/contextWindow/maxTokens/cost/compat/thinkingLevelMap` | 从选定版本目录或明确配置取得；`Model.maxTokens` 是能力上限，请求 `maxTokens` 是本次采样参数。自定义 URL／provider 可能改变自动兼容探测，尤其 DeepSeek thinking 格式，不只改 baseUrl 就视为等价。 |
| API key、endpoint、headers | owner 解析后注入 Pi auth／`apiKey`／headers；endpoint 在 `Model.baseUrl` | Rust 传模型引用与请求数据；凭据不进 renderer、流事件或日志。每次调用固定配置和凭据快照，设置更新影响下一次调用。当前已接模型设置持久化、启动加载／显式更新；OAuth 未实现。 |
| `temperature` | `StreamOptions.temperature` | 保留 optional，不补默认值；实际协议可能因模型推理模式忽略它，验收应检查发出的请求。 |
| `max_tokens` | `maxTokens` | Pi `streamSimple` 缺省用模型上限，并根据估算上下文预留 4096 tokens 后裁剪；budget thinking 路径还会调整输出额度，不能声称旧 optional 字段完全透传。 |
| `reasoning_effort` | simple 的 `reasoning` 或协议专用选项 | Low／Medium／High 名称一致；Max 必须核对 `thinkingLevelMap`，不能统一改成 xhigh，也不能沿用旧 provider 静默 clamp 而不说明。旧 Off 是显式关闭，None 是不发送字段；DSH 把 off 映射为省略 reasoning，但 Pi 部分协议据此主动关闭 thinking，另一些走默认，两者并不普遍等价。当前 off 与缺省均使用 Pi 的缺省 simple reasoning 语义；需要精确协议行为时使用 apiOptionsJson。例如 Anthropic thinkingEnabled=false 明确关闭；不能声称所有协议都区分 off 与缺省。 |
| `extra` | 无整体等价字段 | 旧 sampling 实际传空 map。`priority` 属于旧本地队列，`timeout_ms` 是旧 completion 整体超时，均不能直接改名为 Pi 选项。Pi 0.85.1 有 `samplingParams`（如 top_p/top_k），仅部分 OpenAI 兼容 API 应用且可覆盖命名字段；旧 ChatRequest 无这些独立字段；当前以 samplingParamsJson 承载 Pi 采样扩展，apiOptionsJson 仅接受所选协议声明的选项。 |
| `session_key`、CancellationToken | `sessionId`、`signal` | sessionId 只对支持的缓存／路由生效，不代表 Pi 持有 agent 会话。取消由 Gateway signal 接到 AbortController，见下文。 |

### 流事件与回放映射

Gateway 传领域事件，不传 Pi 对象或每次完整 `partial`。内容块使用同一 `contentIndex`，其索引包括文本、推理和工具，不能当作“第几个工具”的连续序号。旧 sampling 的 HashMap 可以接受稀疏工具索引，但旧文本／推理聚合不能无损表达交错块；新契约需要保留块顺序，不能照抄旧 StreamEvent 就称为全面对齐。

| Pi 事件／字段 | 旧语义／目标映射 | 必须保留的约束 |
| --- | --- | --- |
| `start` | Start | 一个生成请求一次开始；DSH 丢弃 start 是它自身协议的选择，本项目不以此为依据删除开始语义。 |
| `text_start/delta/end` | TextDelta + 有索引的块开始／结束 | delta 为展示增量，end 的完整文本用于校验／最终块，不再次追加。 |
| `thinking_start/delta/end` | ReasoningDelta + 有索引的推理块 | 推理内容与正文分离。旧类型注释说不展示，但 sampling 实际发送 ReasoningStart/Delta/End 给 chat；展示、计时与持久化仍属于 Rust／独立 UI 工作。 |
| thinking／text／toolCall 的 signatures、redacted | 旧 ReasoningSignature／ReasoningItem 的扩展回放信息 | Pi 无独立 signature/item 事件；从最终消息取权威元数据，部分 Responses 签名到 terminal 才补全。保留 `textSignature/thinkingSignature/thoughtSignature/redacted`，不要从思考 delta 重建签名。 |
| `toolcall_start` | ToolCallStart | 从 partial 对应块读 id/name；索引关联整个生命周期，最终 id/name 再校验。 |
| `toolcall_delta.delta` | ToolCallDelta.arguments_delta | 原样传增量用于进度和累计 raw JSON，不能消费 partial.arguments 作为执行参数，尤其 DSH 补丁后不会逐片更新它。 |
| `toolcall_end.toolCall` | ToolCallEnd + 最终对象 | Pi 给已解析 arguments；DSH 将其 JSON.stringify，不能恢复原始字节、格式和解析问题。旧 sampling 用原始串执行 `parse_tool_arguments` 并附加解析异常信息，故新边界需区分原始参数串与最终对象；验证后才由 Rust 执行，未闭合块不得执行。 |
| `done.message.usage`／`error.error.usage` | Metrics | 最终一次快照，先于业务终态；缓存与总量口径见下文。错误／取消中已有用量可保留，但 Gateway 已取消后不保证还能投递。 |
| `done` 的 stop／length／toolUse | Done Stop／Length／ToolCalls | 正常生成结束不等于工具循环结束；收到工具后仍由 Rust 决定是否执行与再请求。0.85.1 新增 deferred；pending 为尚未完成状态，若出现在终态均按不支持的 provider 状态报错，不能当正常完成。 |
| `error` 的 error／aborted、errorMessage | 业务 Error／Aborted | 保留部分内容与安全通用诊断，不回传上游原始 errorMessage。同步调用、认证解析及迭代也可能抛错，不能只处理 Pi error 事件。无终态就结束按截断错误处理。DSH 的字符串错误分类和空响应判错是额外策略，不是 Pi 稳定的 HTTP 错误码。 |
| Gateway cancel／owner close | 取消 Pi signal、结束 reader | Gateway 取消后 next reject，Rust 按本地取消原因结束调用，不能等待一个必达的 Done(Aborted) chunk；超时、owner 关闭与用户取消保持不同原因。终态只能发生一次，迟到 Pi 事件丢弃。 |

用量保留 Pi 的 `input/output/cacheRead/cacheWrite/totalTokens`，以及存在时的 `reasoning`（output 子集，不能再次累加）。兼容旧 `input_tokens` 时使用 `input + cacheRead + cacheWrite`，旧 context 总量再加 output；不能照抄 DSH `inputTokens = usage.input` 就当旧含缓存 prompt 总量。`cached_tokens` 对应 cacheRead，cacheWrite 单列；`eval_tokens` 只能在明确采用未缓存输入口径时对应 input。旧 eval/output 毫秒与 TPS 没有统一 Pi 对应，不伪造；Pi 默认零值也无法可靠区分“服务端未报告”与真实零。Pi cost 来自模型目录估算，不视为账单。

回放采用“有序领域内容 + 带版本的 provider 私有元数据”方向，参考 DSH `replay.ts`：保留 api、provider、请求 model、responseModel、responseId、providerThinkingLevel 和块签名；Anthropic 的实际返回模型与请求别名要分开。Responses reasoning item 在 Pi 中由 thinkingSignature 的 JSON 字符串携带，不能把它当 Anthropic signature。旧单个 reasoning_signature／合并 reasoning_content 不足以恢复多块交错，旧 reasoning_items 也没有完整块位置。校验版本、来源与内容索引后才恢复；换模型／路由或来源不明时不得伪造同模型密文回放。旧历史导入未实现；当前 Agent 回放及持久格式见[历史格式](2026-09-28-agent-chat/history-format.md)。

### Gateway 所有权与已知差异

目标调用方向为 Rust agent → TS ↔ Rust napi 通信适配层 → main GatewayHost → Worker MessagePort 通信适配层 → `services/llm/` worker 内的 typed handler／Pi → 模型服务；响应 chunk 反向返回。Node `worker_threads` 是已选执行方式，utilityProcess 不在当前范围；源码位于 main 目录不表示业务在 main 主线程执行。Gateway 可双向发起响应流，并不意味着本业务需要双向 streaming RPC。当前 `xiaowei.llm.Llm.Generate` 支持独立 system prompt、多轮消息、工具及调用选项，响应 oneof 表达内容块、用量和终态。配置使用 Llm.SetModels，远端目录使用 Llm.ModelCatalog，已应用模型说明使用 Llm.GetModelInfo；不新增 event topic 或取消 RPC。

- `services/llm/` 在 worker 内持有 Pi 适配、模型调用与在途取消；其中 `gateway.ts` 绑定 typed handler。`app/gateway.ts` 负责启动 worker、挂载 owner 和关闭。main 保持唯一 GatewayHost；worker 不另建全局 host，只持有本地执行 endpoint。Gateway worker 通信适配层属于 `gateway/ts/`，不在 LLM 内另造一套业务消息 RPC。该适配层已实现，接口与关闭约定见 [Worker 接入](../../../gateway/ts/README.md#worker-messageport-通信适配层)。service 及其执行限流、超时、流状态和实际清理整体归 worker；main 只做路由、授权和通信转发，不重复持有 service 执行配额。TS core 的 `ExecutionScope` 由 worker endpoint 和 main 本地 handler 分别持有；main 通过独立 `StreamDispatcher` 转发远端流，不另包 producer 状态机。线程两侧的消息关联、失联超时和连接关闭属于通信管理，与 service 执行状态分开。Rust 持有 agent 循环、会话、工具执行、权限、重试／恢复和落盘，不把这些迁入 TS。不开新 crate／npm workspace package，也不新增 raw napi／IPC 通道。
- 现有 `gateway/ts/src/binding/index.ts::StreamHandlers` 已给 handler 传 AbortSignal；Rust typed caller 经 napi endpoint 与 main 转发到 worker。AbortSignal 与 CallContext 不跨线程复制：取消通过控制消息触发 worker 内的 AbortController，main 保留原始上下文，嵌套调用凭与连接实例绑定的 opaque token 回到 main 授权。取消监听须在请求准备前建立，owner close、caller drop／cancel、iterator return 都终止上游并清理监听与 reader；不能只靠 async generator 的 finally 等待一个永不返回的 next。初始化失败和重复关闭沿用 main 的显式生命周期规则。
- admission、授权、超时与帧错误保留 Gateway 错误通道；已进入模型生成的 provider 失败以业务终态承载，Rust 同时处理两条错误路径。Gateway 的 open 成功只代表开流成功，不代表远端模型已接受请求。
- Gateway 限流／chunk policy 不会限制 Pi 内部缓存。Pi `utils/event-stream.js` 使用无界 push 队列且 partial 引用累积消息，pull 或额外包一层有界 Gateway 队列不构成端到端背压。当前限制输出上限并验证取消／慢消费者清理；大输出的内存界限仍须专门解决，不能宣称已有严格有界网络背压。
- 旧 HttpBackend 有 prepare 阶段错误分类、Retry-After 和重试策略；DSH 明确 `maxRetries: 0`，由 agent 记录可见重试。当前同样单次调用、关闭 SDK 重试，之后再对齐 Rust 恢复策略，避免双层重试或重放已输出内容。
- 旧 ResponsesTransport 根据 session_key 复用 WebSocket／chain 并支持 HTTP 路径；Pi 0.85.1 的通用 `api/openai-responses.js` 走 HTTP 流，没有该 WebSocket 分支。其他 Pi API 的 transport 支持不能证明通用 Responses 等价。现已通过补丁实现通用 Responses 连接复用和 previous_response_id；具体隔离及失败边界见 WebSocket 小节，不承诺旧版所有断线恢复语义。
- Pi error 常将异常压成 errorMessage，无法保证保留旧 HTTP status、Retry-After 和 cause。可保存实际拿到的状态／诊断信息，但不从字符串推断出可靠结构化状态；DSH 的分类仅作为参考。

### 已实现：生成 service 与模型目录

模块按 main 宿主入口、worker/ 实现和 shared/ 纯配置代码组织；通用组织与依赖规则见 [main 模块组织](../../../desktop/src/main/README.md#host-与-worker-的代码组织)。启动读取为 startup-config.ts，配置 PB 转换为 shared/configuration-codec.ts。此整理仅调整路径与命名，不改变调用链或协议。构建入口、宿主导入、自动测试和手动验收工具已同步；desktop 全量回归（含 40 项 LLM 测试和 Rust typed caller）通过。

`host.ts` 创建专用 Worker，`worker/index.ts` 暴露 `worker/gateway.ts` 的 typed handlers；`worker/provider.ts` 编排调用、取消和清理，`worker/apis.ts` 选择 Pi 公共 `api/*.lazy` 适配器。`worker/messages.ts` 转换消息／完整回复，`worker/options.ts` 转换调用参数，`worker/events.ts` 映射流事件，`worker/catalog.ts` 拉取模型列表。Pi 类型仅用于这些适配模块，应用模型配置和 PB 不继承 Pi 类型。main 的 `app/gateway.ts` 负责接入和关闭，默认空配置不发请求。

Generate 的 `messages` 支持有序 user、assistant、toolResult；图片使用 MIME 与 bytes，转换成 Pi 的 base64。工具 schema 只声明能力，工具执行属于调用方。assistant 回复保留来源、时间戳、responseId／responseModel、签名／redacted、用量及终止原因，可原样放入下一轮历史。历史迁移和持久 schema 不属于本片。`userText` 是与 messages 互斥的单轮简写，为已有消费者保留文本增量／终态序列；messages 请求提供全部 start／block start／delta／end 生命周期。

事件按 contentIndex 保序，文本 delta 与 thinking／toolcall delta 分开。块开始不携带已累积的文本或中间工具 arguments；redacted thinking 可在开始时携带完整密文。块结束和 finished.message 是权威快照，不能再次作为增量追加。补丁保留的工具原始 JSON delta 用于进度，最终 argumentsJson 才是完整参数。成功发送一次 usage 再一次 finished；provider 错误发送 failed，包含部分内容／用量，但剔除原始错误诊断字段。输入、资源和 Gateway 生命周期失败使用 Gateway 错误通道；取消后不保证业务终态必达。

采样支持 temperature、maxTokens、reasoning／thinking budgets、工具选择、samplingParams、缓存、session、transport、SDK 超时及 metadata。通用选项调用 streamSimple；apiOptionsJson 切换到协议专属 stream，与通用 reasoning／预算／工具选择互斥，只接受所选 Pi API 的已声明字段，不接受 Key、signal、fetch 或回调。强制工具选择通过协议专属 toolChoice 表达。模型 samplingParams 与请求 samplingParamsJson 统一按“模型默认值 → 请求覆盖”合并，simple 与协议专属 stream 路径保持一致，合并不修改配置快照。samplingParams 的实际生效范围、transport 和推理等级仍由 Pi 与上游模型决定，不把不同 API 的能力视为等价。SDK 自动重试关闭。

maxTokens 缺省使用模型配置上限，显式范围为 1–模型上限；Pi simple 仍会按估算上下文预留 4096 tokens 并调整 thinking 预算。temperature 缺省不传，显式范围 0–2。单轮简写 system/user UTF-8 合计至多 256 KiB；转换后的完整 Context JSON 至多 16 MiB。文本、thinking、工具 JSON delta 累计至多 1 MiB，完整单事件编码同样不得超过 1 MiB（包括签名和无 delta 的终态参数），超出返回 RESOURCE_EXHAUSTED。

LLM 不单独覆盖并发，沿用 Gateway 默认 owner 128 路／caller 32 路；它是框架资源保护，不是 LLM 业务额度。worker 的 producer／consumer idle 各 30 秒、总时长 120 秒。取消直接触发 Pi AbortController，finally 等待 result 后移除监听；慢消费、thinking／工具阶段及 owner 关闭均有回归。Pi 内部 push 队列仍非严格有界背压，大请求不能依赖 Gateway 配额获得严格内存上界。

Llm.ModelCatalog 是可取消的分页响应流，用现有本地 modelRef 或显式草稿连接／Key 拉取模型列表，不修改已配置模型。默认支持 OpenAI 兼容和 Anthropic 列表格式，DeepSeek 两个推理入口均使用官方 `https://api.deepseek.com/models`。其他目录格式需另行适配，不能假定每个生成协议都有 OpenAI 格式的 models 接口；调用方可显式提供 url／format 连接兼容目录。分页检查重复游标及跨 origin 跳转，错误脱敏，Key 不进入结果。目录只返回上游实际给出的 ID、名称及可选能力信息，缺失上限／价格不猜测。

构建输出独立 ESM `llm-worker.js`，内联 Gateway／契约、外置补丁后的 Pi；普通 Node 可执行。`pnpm --dir desktop test` 覆盖构建 worker、本地三协议 SSE 和 Rust typed caller → napi → main → worker → Pi；Rust fixture 不进入生产 search 接口。真实验收入口与模式见 [手动验收脚本](../../../desktop/scripts/README.md)。Electron 应用包加载／签名不由 Node 验收替代。

### Settings 模型配置与持久化

#### 提供方与模型身份

- 预设菜单按提供方聚合一次，可从其固定的协议／URL 组合中选择；不能任意改预设 URL。自定义地址可编辑，协议仅 OpenAI Completions、OpenAI Responses、Anthropic Messages。底层现有十种 API 的支持不删除。
- 仅展示当前 API Key／环境变量方式可工作的预设，不展示依赖登录或云专用凭据的入口。
- 提供方名称可修改，trim 后不能为空且不能与其他实例重名；同一预设可以创建多份实例。
- provider 实例 `id` 和每条模型配置的本地 `id` 均由宿主在首次保存生成并持久化。编辑名称、上游 ID、地址或凭据不改变这两个 ID。模型的本地 `id` 就是 Generate.model_ref，不使用 name/model 拼接值。
- 模型上游 `modelId` 在单一提供方内唯一，跨提供方可以相同。模型名称可空；统一显示 name.trim()，为空则显示 modelId。应用选择器使用同一解析结果，最终显示 provider_name/model_name（斜杠两边无空格）以区分实例；SetModels 及 Host 分别保留两个名称。
- 模型编辑／添加复用独立弹窗：ID、名称、图片输入、思考强度、上下文窗口、最大输出、自定义请求头。卡片精简展示能力标签与已设置数值；删除二次确认。
- 修改协议／URL／Key／环境变量保留所有已添加模型及配置。候选列表仅属于单次导入弹窗，每次打开重新获取，不新增连接变化时的清空流程。

#### 凭据与校验

- 提供方名称、合法 HTTP(S) URL 必填；非空 apiKey 或 apiKeyEnv 名称至少一个。模型列表允许为空，空列表不进入应用模型选择器。
- 编辑已保存 Key 时只返回 hasApiKey；输入框提示“已配置 API Key，留空保留当前值”。显式保留、替换、清除操作与空字符串区分；清除后仍需满足环境变量名／Key 至少一个。
- 运行时非空环境变量优先，否则使用文件 Key；均无值时在 HTTP 前报错，不能发送匿名请求。只填写环境变量名仍允许保存，即使当前进程里尚无该变量；这属于凭据不可用，不是 worker 更新错误。
- 对不可解析凭据的提供方保留文件条目与不可用原因，不把无效 ResolvedModelConfig 提交 worker；其他提供方仍可生效。快照返回可用性，脚本选择不可用条目时明确报错。环境变量只读取进程快照，不新增监听或动态环境配置。
- Key 不出现在列表、事件、日志、错误或测试 fixture 的真实内容中；草稿目录请求可以携带新 Key，结果不能回传 Key。

#### 模型参数

- 上下文缺省为 256,000（256K），最大输出缺省为 32,768（32K）；预设、导入或用户填写的值优先。统一使用整数 tokens 存储和比较，不按 K／M 字符串匹配。
- 默认值在配置规范化时补齐；正整数且最大输出不超过上下文，否则提示修改，不静默截断。预设／远端显式值不是默认值，不覆盖已有用户修改。
- 思考强度只保存明确的 reasoning 和 thinkingLevelMap，不保存“自动适配”或“原有映射”标记。预设／导入映射逐键匹配现有选项；缺失或未匹配时初始化为不支持推理，用户选择具体方案后才开启。
- 选项顺序：不支持推理；关闭／低／中／高／更高／最高；关闭／低／高／最高；关闭／高／最高；最低／低／中／高；低／中／高；低／高／最高。第一个支持推理的方案对应正式 OpenAI gpt-6-sol，minimal=null，无 ultra。关闭推理时清除旧映射，不能保留隐藏映射使后端再次开启。
- DeepSeek Flash ID 为 deepseek-flash，名称 DeepSeek-V4.1-Flash；保留当前已确认预设数值及 Flash／Pro 各自映射。
- Headers 为多行 Key/Value；空白行忽略，值非空但名称为空、大小写不敏感的重复名称均拒绝；“+ 添加”在最后一行右侧。
- compat 暂不提供编辑器；已有 compat、samplingParams、cost 等高级数据在常规编辑中保留，不新增高级 JSON UI。缺少 cost 沿用现有适配器零估算输入，不把它显示为真实免费价格，本片不建立计费系统。
- supportsWebSocket 缺省 false，预设自动带入，属于连接能力元数据，不塞入 Pi Model。传输偏好独立保存；http 对应调用层 sse，支持 WebSocket 且选择 auto 时通用 Responses 优先使用 WebSocket，握手失败可回退。具体连接复用及续接规则见 WebSocket 小节。
- 默认模型、小文本模型引用稳定模型 ID；默认思考等级是调用偏好，与能力映射分开。选择器仅提供所选模型允许的档位；能力或模型删除后清理无效偏好，不保留悬空引用。Agent 的初始模型选择和独立会话配置见[Host](2026-09-28-agent-chat/host-interface.md)。

### 唯一文件格式与边界

格式在 `desktop/src/main/services/llm/config.ts` 定义，不继承 Pi Model，不让 renderer 导入 main 文件。结构固定为：

```text
ModelConfigDocument
├── version: 1
├── providers[]
│   ├── id, name, preset
│   ├── provider, api, baseUrl           # SDK 路由标识与可编辑显示名独立
│   ├── apiKey?, apiKeyEnv?
│   ├── supportsWebSocket, transport
│   └── models[]
│       ├── id, modelId, name?
│       ├── input, reasoning, thinkingLevelMap?
│       ├── contextWindow, maxTokens
│       └── headers?, compat?, samplingParams?, cost?
└── defaults
    ├── modelRef?
    ├── smallTextModelRef?
    └── thinkingLevel?
```

- 模型属性打平到自有模型条目，不嵌套 Pi model 对象；连接与凭据在 provider 层集中保存，加载时展开为现有 shared/models.ts 的运行时配置。
- 默认路径由 app/paths.ts 提供 ~/.xiaowei/models.json；XIAOWEI_AGENT_HOME 为绝对路径时，将 Agent 与模型设置根目录共同改到该目录，模型设置写入其中的 models.json。XIAOWEI_LLM_CONFIG 仍可用绝对路径单独覆盖模型文件，优先于根目录，读写共用最终路径。
- 默认文件缺失得到空配置；显式指定路径缺失、坏 JSON 或格式错误报告错误，不覆盖原文件。不再兼容旧 `{ models: [...] }` 输入。
- JSON 两空格缩进、末尾换行、稳定字段顺序和列表顺序；同目录临时文件写入后 rename 替换，失败清理临时文件。首次创建目录；不要顺带引入通用存储框架。
- config.ts 提供类型、规范化／校验、读取／原子写入及文件配置到运行时配置的转换；无 Electron、Gateway 注册或 worker 导入。脚本直接引用它，不复制 schema。
- 宿主 llm/gateway.ts 实现 ModelSettings handlers，持有持久配置快照、revision、串行修改队列和应用状态，具体配置处理调用 config.ts；host.ts 仍只管理 worker 生命周期与通信。worker 不读取配置文件或环境变量，只消费解析后的模型快照。
- 保存先生成下一份内存候选，完成校验和运行时转换，再写文件；写成功后发布持久快照并同步 worker。文件失败丢弃候选，旧配置继续有效。仅运行时模型实际变化时 SetModels，默认偏好变化不触发替换。
- 复用 shared 校验和 codec，在落盘前排除正常配置导致的 worker 拒绝；worker 校验整批成功才替换。旧请求保留旧模型／Key 快照。
- worker 退出或通信失败不能在程序层面绝对排除：发生时保留已保存文件、显式返回已保存但未应用的故障，不伪报成功。记录 saved revision 与 applied revision；同一队列内重新应用最新快照，不重放旧编辑或回滚文件。故障恢复入口只用于异常状态，不新增常规“重新加载文件”流程。

### Gateway 接口与调用方向

配置契约位于 `contracts/proto/xiaowei/model-settings.proto`，package 归 xiaowei.llm，service 为 ModelSettings；与 Rust 通用 SettingsService 分开，它不存 Storage。具体字段编号、optional／oneof、错误含义在 proto 注释中说明。worker 统一使用现有 Llm service，移入目录方法并将运行时配置方法命名为 SetModels；删除 LlmConfiguration 与 ModelCatalog service，ReplaceModelsRequest 同步改为 SetModelsRequest。这是未发布接口的同步调整，不保留旧路由别名。

| 方法／事件 | 语义与 owner |
| --- | --- |
| ModelSettings.Get | main 返回无 Key 快照、配置 revision、应用状态及可用性 |
| ModelSettings.SaveProvider | 新建或编辑完整 provider 草稿；带 expected_revision、Key 保留／替换／清除 oneof；模型本地 ID 新增可缺省，已有必须保留并校验归属 |
| ModelSettings.DeleteProvider | 带 ID 与 expected_revision；删除并清理默认引用，返回新快照 |
| ModelSettings.UpdateDefaults | 更新稳定引用和默认等级，校验引用与可用档位 |
| ModelSettings.ListModels | 可取消流：接收尚未保存的连接草稿、可选已保存 provider ID 与 Key 操作；main 解析保留 Key／环境值后调用 worker 目录服务 |
| ModelSettings.Reapply | 异常恢复时重新提交当前最新内存快照，不读磁盘，不修改已保存文件 |
| ModelSettingsChanged | main 显式发布无 Key 快照／revision／应用状态；成功提交或应用状态变化后发布 |
| Llm.ModelCatalog | 现有 worker 方法增加显式连接输入；与 model_ref 二选一并校验。保留当前 model_ref 调用，无需伪造临时模型或 SetModels |
| Llm.SetModels | 设置完整运行时模型集合，不是增量合并；空列表清空。全量校验后原子替换，在途请求保留旧快照；复用 host.updateModels，不传环境变量名 |
| ModelSettings.GetAuxiliaryModelRef | main 返回当前 smallTextModelRef，缺省表示未配置；不返回完整设置 |
| Llm.GetModelInfo | worker 返回 Generate 使用的同一个已应用模型 Map 的安全说明，独立 provider_name／model_name 不预先拼接 |
| Llm.Generate | 保留现有生成请求及流事件语义，供 Agent 和手测脚本调用 |

renderer → ModelSettings（main）→ 文件／Llm.SetModels（worker）；目录为 renderer → ModelSettings.ListModels（main）→ Llm.ModelCatalog（worker）。main 转发流保留调用上下文与取消；不改 raw IPC／MessagePort。handler 在各自 owner 显式注册，应用只创建一个 GatewayHost。

handler 按业务模块和执行位置归属，不按 service 数量拆文件：宿主 `llm/gateway.ts` 实现 `ModelSettings`；`llm/worker/gateway.ts` 实现单一 `Llm` service（Generate、SetModels、GetModelInfo、ModelCatalog）。前者面向 Settings UI，后者的生成与模型说明接口面向 Agent，配置替换和目录服务用于内部协作。每条方法路由保持唯一 owner。

revision 用于拒绝旧页面覆盖较新编辑；冲突保留草稿并提示刷新。UI 先完成事件订阅 ready 再 Get，用 revision 避免旧读取覆盖事件；卸载取消订阅与导入流。

默认思考强度位于默认模型下方；未选模型时禁用并提示先选择默认模型，不支持推理时禁用，选定后仅展示该模型映射允许的档位。名称校验在编辑或失焦后展示，提示与名称标题同行；保存／删除成功使用 3 秒 Toast，不占页面布局。没有提供商时显示居中的空列表提示。

手动验收工具和应用共用 config.ts。先使用 `--config ~/.xiaowei/models.json --list` 查看稳定 ID，再用 `--model <id> --mode complete` 调用；其他能力模式及构建前置见 [脚本说明](../../../desktop/scripts/README.md)。脚本不写回文件、不修改应用中的 worker，不纳入自动测试门禁。

### Responses WebSocket

用户要求保留 openai-responses、base URL 和 API Key，并实现连接复用；上游通用 Responses 只有 SSE，Codex 适配器的认证／URL 规则不能直接用于 API Key 代理。因此复用其 WebSocket 传输与池，保留通用 Responses 的请求构造及来源语义，不另加 Codex 协议选项。

源码与真实验证参考代理部署提交 `81e9a1c67bd74169b23772ee848b215e4e8ee1db`。独立客户端验证同连接生成及 previous_response_id 续接可用；产品真实桌面对话也观测到跨轮同连接、增量输入及无 SSE 回退。它证明客户端到代理的复用，不能推断代理到上游的传输。连接已断后不能把 response ID 当作跨连接持久会话。实验性的临时适配副本／打点已移除，不是产品入口。

#### 已确认并实现的接入边界

用户最终确认保留现有 `openai-responses` 协议、base URL 和 API Key，开启已有 WebSocket 开关后自动使用连接复用与增量续接。未采用新增 Codex 协议选项或改配 `/backend-api` 的建议。正式实现不调用 Codex 的整个生成入口，而是在 pnpm patch 中让通用 Responses 复用 Codex 的 WebSocket 传输、池与事件归一化；通用适配器继续构造请求、转换历史、持有 `openai-responses` 来源和应用本协议计价。运行时共享 helper 不作为应用依赖的公开入口。

- 现有文件格式和用户文件不变。宿主将提供方 `supportsWebSocket && transport === "auto"` 解析为运行时 `defaultTransport: "auto"`，否则为 sse；`Llm.SetModels` 新增 `ModelTransport` 枚举字段携带该值，未知值拒绝。调用层缺省使用配置，显式 Generate transport 可覆盖。未向 Pi Model 塞入传输元数据，UI 不新增协议或字段。
- 通用 Responses 请求固定由 `{baseURL}/responses` 得到，WebSocket 仅转换 HTTP(S) scheme；API Key 使用 Bearer，保留既有 headers。模型列表仍为 `/models`。不解析登录 JWT、不添加虚构 account ID、不修改服务器路由，也不在应用修改全局 WebSocket／fetch。
- 同一会话需提供稳定 sessionId。池按 session、协议入口／provider、完整 URL 与有效握手 headers（包括凭据）隔离。相同身份可跨轮复用；并发忙连接或并发初次握手的额外连接是临时连接，不覆盖池内连接。凭据／地址／headers 变化使用独立连接；在途请求保留旧快照，旧空闲连接按原有 5 分钟 TTL 回收，连接最大年龄沿用 55 分钟。
- auto 与 websocket-cached 在非 input 参数一致、完整历史匹配“上轮完整输入 + 上轮回复”、且有新增输入时发送 `previous_response_id` 和 delta。每轮消费旧基线，仅成功终态建立新基线；历史修改、参数变化或完整输入模式不会留下可误用的旧基线。websocket 模式复用连接但发送完整输入。缺少 sessionId 时为单次连接；cacheRetention=none 只关闭提示缓存，不关闭通用 Responses 的连接复用。
- auto 仅在尚未发送 response.create 的连接失败时回退 SSE。websocket／websocket-cached 不回退。发送后普通断线／超时直接失败，即使还没有正文；避免不确定上游是否执行时静默重发。仅增量续接明确返回 previous_response_not_found、且未观察到任何正常响应事件时，允许重新连接并发送完整输入重试一次。共享 Codex 原有对应重试也增加“尚未开流”限制；其他 Codex 调用的认证、请求及 URL 规则保持。
- 取消关闭该请求连接，不建立续接基线；成功归还池后再 abort 本次 controller 不影响下一轮。显式清理后迟到的归还不能重新留下池外连接。worker 保留 Gateway 的关闭／取消与线程终止流程，并在 parent port 关闭时执行 Pi session resource cleanup；自动回归验证远端连接实际断开。生成失败继续由既有脱敏业务终态表达。
- SDK 请求构造仍遵循通用 Responses，包括 maxTokens、samplingParams、toolChoice、reasoning 以及 system／developer 历史；没有套用 Codex 专用构造器而丢失参数。Pi 内部 push 队列仍无严格有界背压，不把新增 WebSocket 支持描述为解决了内存界限。compact、steering、跨连接持久续接、OAuth 和产品 agent 不属于本片。

手测脚本为每次运行生成独立 sessionId，工具两轮共用；默认读取原配置，可用 `--transport websocket-cached` 强制验证 WebSocket，或用 `--transport sse` 验证 HTTP。只覆盖本次执行，不写回文件。自动测试检查实际连接数及帧内容，不以“生成成功”替代连接复用／增量验收。补丁维护与升级入口见 patches/README.md。

当前 Quick Chat 通过 Agent 执行，xiaowei-agent 的生成 adapter 将持久 SessionId 传入 Generate.options.session_id；同会话跨轮稳定，新会话有独立 ID。连接池仍只存在 worker 内存，应用重启后重新建立连接，不能以持久 SessionId 推断网络续接基线已恢复。

### 认证范围：当前仅 API Key，其他方式暂缓

用户确认本片仅支持 API Key 认证：直接输入 apiKey，或通过 apiKeyEnv 指定环境变量，沿用环境变量非空时优先的规则。账号登录与云平台专用凭据暂不实现，不因 Pi 内置相关能力而扩大本片范围。

暂缓项包括浏览器 OAuth、设备码、手动授权回填、Token 刷新／退出，以及 AWS Profile／默认凭据链、Google ADC／服务账号文件、云平台账户／项目／地域等专用交互。具有 API Key 和账号登录两种方式的提供方，本片只接 API Key；必须依赖上述暂缓能力的入口不宣称可用。已有兼容 API 代理仍可通过自定义地址和 API Key 配置，不等于接入厂商账号登录。

后续在提供方编辑器的认证区域扩展认证方式选择，再按实际流程显示授权状态或云平台字段，继续复用模型列表与编辑交互。当前不预建空登录服务、OAuth 契约、凭据框架或占位向导；认证解析与模型元数据的边界保持独立，未来新增方式仍解析为生成端需要的运行时认证信息。

### Settings 模型兼容参数的后续范围

本轮先不增加 compat 编辑界面。compat 用于处理自定义接口对同一协议的细节差异，例如输出参数名、developer 消息支持、thinking 格式和工具消息约束；后续遇到具体接口问题时，再依据真实请求与响应调试并补充。已有模型的 compat 数据在设置保存和转换时应保留，不因 UI 未展示而丢失。此决定不缩减底层已经实现的兼容字段支持。

## Alternatives considered

- 迁入旧 `crates/xw-llm/` 的协议实现：用户已明确选择复用 Pi，不再推进此方案。
- 在 renderer 中直接调用模型：无法保住当前 main／Gateway 的调用与凭据边界。

## Outcome

已交付 Node worker 中的 Pi provider、完整生成／工具声明与结果回传契约、取消及安全错误、远端目录、整批模型更新和模型设置持久化。设置产品已通过用户真实配置及调用验收；默认 models.json 位于 Agent 根目录，XIAOWEI_AGENT_HOME／单文件覆盖规则见本节文件说明。当前 Pi 固定为 0.87.1，工具参数解析及通用 Responses WebSocket 补丁的来源和维护方式见 patches/README.md。

真实 worker／Gateway 以用户指定配置验证 DeepSeek Completions／Anthropic Messages、代理 Responses 的文本、thinking、图片、工具往返及取消；通用 Responses WebSocket 的工具往返、thinking、连接复用及取消也已验证。上游未提供的价格／能力不视为实测；曾有一次并发 cancel-thinking 失败，单独重测通过，未取得原因，不宣称已定位。

相关 Pi 补丁回归、真实本地 SSE／WebSocket fixture、worker 配置隔离与关闭、Rust typed caller／正式 napi、契约 codec／生成一致性、desktop 回归／构建、frozen install 和 just check 已通过。应用包加载／签名不能由 Node 测试替代；并非全部十种 API、认证方式及补丁路径都有本项目真实运行回归。

Agent 接入时增加独立 provider_name、Llm.GetModelInfo、ModelSettings.GetAuxiliaryModelRef 和真实首 SSE 观测，缺省预算统一为 256_000／32_768。接口 owner、适配边界及专项验证统一见[Agent Host](2026-09-28-agent-chat/host-interface.md)和[交付证据](2026-09-28-agent-chat/implementation-results.md)，不在此重复 Agent 执行计划。

本事项已交付的模型能力继续生效，对应实施计划已删除。OAuth／特殊云凭据、本地模型、图片生成、deferred、文件监听及 Agent 工具执行不属于已交付能力；模型兼容参数编辑遇到具体接口需求再实施。main／剪贴板的历史迁移流水不再混入本 record，当前模块约定见[main README](../../../desktop/src/main/README.md)。
