# 基于 Pi 的 LLM provider

## Why

Quick Chat 后续需要模型调用、流式事件、工具、取消和推理内容。用户决定复用成熟的 Pi 模型调用库，并希望通过现有 Gateway 让 TypeScript 的模型生态与 Rust 的 agent／会话能力协作，而不是迁入旧版 `xw-llm` 的自有 HTTP、SSE 和 WebSocket 实现。

## What

建立可供后续 Quick Chat 运行时使用的 Pi provider 边界。最终需能按当前设置选择模型和凭据，处理请求、流式文本／推理／工具调用、使用量、结束／错误与取消，并经 Gateway 供 Rust agent 调用。按用户要求一次只推进一个小切片；已完成适配边界核对、Gateway worker 通信、Pi 补丁与最小文本流调用；LLM service 在 Node worker 内运行，宿主配置／凭据及完整消息语义继续分片接入。

本事项不接入 Quick Chat 产品 UI，不改变会话数据，也不以直接模型调用代替旧 agent 的工具与恢复语义。UI 入口预览另见 [Quick Chat UI 事项](2026-09-24-quick-chat-ui-interaction.md)。

## How

旧版源码位于 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，本轮核对 HEAD `6be131098d0b907b988f7f53460f450c89b9034c`。旧 `xw-agent-runtime` 通过 Rust `ChatProvider::stream` 接收 `ChatRequest`、`StreamEvent`，`xw-agent-protocol`／rollout 也复用 `xw-llm::types`。采用 Pi 后需保留必要的领域数据语义，并建立 Rust↔TS 适配；不能直接把 TypeScript 库实现为 Rust trait。

当前 Gateway 已支持 TypeScript owner、Rust caller 和双向响应流，但尚无 LLM 业务契约。main 的目录规则和现有文件归属维护在 [Electron main 模块组织](../../../desktop/src/main/README.md)。Pi provider 的目标位置为 `desktop/src/main/services/llm/`，由 `app/gateway.ts` 装配和关闭；本阶段不新增 Rust crate 或 npm workspace package。后续 Rust agent 经 Gateway 调用该 owner；具体业务契约需根据旧事件处理和 Pi 输出逐字段核对后决定，特别是交错的文本／推理／工具块、工具参数 JSON、取消、使用量、错误和推理回放。

`@mariozechner/pi-ai` 与 `@earendil-works/pi-ai` 是同一 Pi 项目的旧／新发布名，并非两个并行分支：旧 GitHub 地址 `badlogic/pi-mono` 重定向到 `earendil-works/pi`，两个地址当前指向同一提交；旧 npm 包已标记弃用并提示改用新包。后续使用 `@earendil-works/pi-ai`。用户给出的本地 DSH `/Users/changtang/Develop/LLM/deepseek-harness` 已使用新包（更新后锁定 0.85.1，并携带工具参数流式解析补丁），其 `packages/llm/llm-pi-ai/` 是 DSH 自己的适配层，可参考 `src/context.ts`、`stream.ts`、`provider.ts` 的映射，不复制 Cordis、凭据或会话系统。本项目已在 desktop 安装固定版本 `@earendil-works/pi-ai@0.85.1`，并登记同版本 pnpm 补丁。

现有设置模型页仍是 Storybook mock；提供方配置、Key 获取和模型目录由后续切片衔接。Pi 的协议名与设置页的 `openai-completions`、`openai-responses`、`anthropic-messages` 一致，但能力、上下文上限和输出上限需有明确来源。旧版与 Pi 在重试、Responses WebSocket、推理回放和错误细节上的差异要逐项验证并记录。

### 核对基线与 DSH 的两层适配（2026-09-24）

本轮按用户要求将 `/Users/changtang/Develop/LLM/deepseek-harness` 的 `master` 从 `99f6f02fec` 快进到 `46a7f68b0922371ce7144b668b90e377d8e799f4`，更新后工作区干净。最终结论以更新后的源码和 lockfile 为准：依赖声明 `^0.85.1`，锁定 `0.85.1`，patch hash 为 `b9bcce474fb2ac44633dff0fa722816a5bff5451b4575d5874035ea14ba70a4f`。没有在 DSH 执行依赖安装，原 node_modules 仍为 0.82.1，不能拿它验证更新后的行为；本轮另读取 npm 发布的 0.85.1 包与仓库补丁进行静态核对。更新前安装包与 npm 0.82.1 的 712 个文件一致，只能说明旧快照没有修改包本体。

DSH 并非直接裸用 Pi，须区分两层：

- `packages/llm/llm-pi-ai/src/` 是 DSH 自己的适配层：`catalog.ts`／`provider.ts`／`models.ts` 解析模型和协议，`adapter.ts` 冻结配置快照、注入认证、关闭 SDK 重试、管理取消及 idle watchdog，`context.ts`／`stream.ts`／`replay.ts` 转换消息、事件与持久回放。新版另有 `auth.ts`／`login.ts` 承接凭据存储与 OAuth；这些不属于本项目本片范围。
- `patches/@earendil-works__pi-ai@0.85.1.patch` 通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 修改 Pi 本体。它删除 Anthropic、Bedrock、Mistral、OpenAI Completions、Responses shared、Pi Messages 六处参数 delta 对累计 JSON 的重复解析，保留 delta 字符串和终态解析。DSH 只依赖增量和最终参数，不依赖 partial.arguments 随片更新；其 README 指出大参数会触发累计重解析的 O(n²) CPU 开销，`tests/tool-argument-streaming.spec.ts` 用 Completions／Responses mock 覆盖此约束。未运行 DSH 的该测试；XiaoWei 已原样引入补丁，并以 补丁 Node 测试独立覆盖两个协议。

因此参考 DSH 时须分别注明 Pi 公共能力、DSH 适配策略和补丁行为。desktop 的运行时依赖固定为 `@earendil-works/pi-ai: "0.85.1"`，根 `patchedDependencies` 绑定原样复制的 DSH 补丁；锁文件由 pnpm 生成。公开运行时窄入口使用 `@earendil-works/pi-ai/api/openai-completions` 等协议入口，类型可从根入口导入；Gateway 不依赖 Pi。provider 计划在 Node worker 中运行，但线程隔离不能消除累计 JSON 重解析开销。Completions／Responses 的本地 SSE 回归验证原始 delta 顺序、中间不构造参数对象、最终参数完整及成功终态；另外四个协议仅复用来源补丁，尚无本项目运行时回归。这只验证依赖行为，不包含工具执行。补丁仅修改发布包的运行时 JS，不改变类型接口；消费方累计原始 delta，在 `toolcall_end` 读取最终参数，不能依赖中间 `partial.arguments` 更新。回归入口为 `pnpm test:patches`（`patches/tests/pi-patch.test.mjs`，从 desktop 解析实际安装的 Pi）。通用修改和升级／退役步骤见 [补丁维护](../../../patches/README.md)。

### 请求映射（目标边界，尚未实现）

旧 Quick Chat 的 `xiaowei/src-tauri/src/biz/quick_chat/commands.rs::quick_chat_send` 经 Studio `bridge/quick_chat.rs::send_message` 委托 chat；模型请求由 `crates/xw-agent-runtime/src/agent_loop/sampling.rs` 构造。动态 system prompt、工具定义、历史、会话和工具循环属于 Rust agent，而非 Pi provider。以下以旧 `crates/xw-llm/src/types.rs`、`remote_provider/resolver.rs` 和 DSH 对应适配文件为依据。

| 旧请求／配置 | Pi 对应 | 转换与差异 |
| --- | --- | --- |
| `system_prompt`（已合并动态片段） | `Context.systemPrompt` | 按请求传入。Pi 消息 union 没有 system role；DSH 仅在无显式 system 时提取首条 system，其余降为 user。XiaoWei 不照搬这种角色降级：首片只接受独立 system prompt；历史 system 的迁移另行显式处理。 |
| user 的 Text／Image、timestamp | `UserMessage`，text／image，`mimeType`、原始 base64 | 保留内容顺序与毫秒时间戳；图片要求模型 `input` 包含 image。DSH 另做附件读取、缩放、预算与卸载，不能当成 Pi 自带文件生命周期。本片不迁移附件系统。 |
| assistant 的 Text／ToolCall | `AssistantMessage.content` 的 text／toolCall | 工具 `id/name/arguments` 对应；Pi arguments 为对象，边界须验证。Pi 历史还需要来源 `api/provider/model`、usage、stopReason、timestamp；旧消息没有完整来源，不能用当前模型伪造历史来源。无原生回放信息时只能明确作为降级历史。assistant image 无对应，须拒绝。 |
| `reasoning_content/signature/items` | thinking 块、`thinkingSignature`，及响应来源元数据 | 不能仅拼接推理字符串；需按块保存回放，见下文。旧数据转换不属于最小调用。 |
| ToolResult：`tool_call_id/tool_name/is_error/content` | `ToolResultMessage`：`toolCallId/toolName/isError/content` | 保留文本／图片与调用关联；缺失名称可由对应历史 toolCall 查得，不能丢掉关联。工具执行、权限和恢复归 Rust。 |
| `ToolDef.parameters_schema` | `Context.tools[].parameters`（JSON Schema／TypeBox 结构） | name／description 原样；provider 只声明工具，不执行工具。旧 agent 对 schema 的 UI description 增补仍在 Rust。 |
| 逻辑模型 ID、ProviderConfig | `Model.api/provider/id/baseUrl`，provider auth 与请求 headers | 旧 `openai/anthropic/responses` 对应 `openai-completions/anthropic-messages/openai-responses`。旧 `provider/upstream` 和 DeepSeek 历史别名先解析为明确路由及上游 ID，不能把整串直接作为 Pi model.id；新设置模型引用由后续配置切片衔接。 |
| 模型能力 | `reasoning/input/contextWindow/maxTokens/cost/compat/thinkingLevelMap` | 从选定版本目录或明确配置取得；`Model.maxTokens` 是能力上限，请求 `maxTokens` 是本次采样参数。自定义 URL／provider 可能改变自动兼容探测，尤其 DeepSeek thinking 格式，不只改 baseUrl 就视为等价。 |
| API key、endpoint、headers | owner 解析后注入 Pi auth／`apiKey`／headers；endpoint 在 `Model.baseUrl` | Rust 传模型引用与请求数据；凭据不进 renderer、流事件或日志。每次调用固定配置和凭据快照，设置更新影响下一次调用。首片使用测试注入，不接真实设置／OAuth。 |
| `temperature` | `StreamOptions.temperature` | 保留 optional，不补默认值；实际协议可能因模型推理模式忽略它，验收应检查发出的请求。 |
| `max_tokens` | `maxTokens` | Pi `streamSimple` 缺省用模型上限，并根据估算上下文预留 4096 tokens 后裁剪；budget thinking 路径还会调整输出额度，不能声称旧 optional 字段完全透传。 |
| `reasoning_effort` | simple 的 `reasoning` 或协议专用选项 | Low／Medium／High 名称一致；Max 必须核对 `thinkingLevelMap`，不能统一改成 xhigh，也不能沿用旧 provider 静默 clamp 而不说明。旧 Off 是显式关闭，None 是不发送字段；DSH 把 off 映射为省略 reasoning，但 Pi 部分协议据此主动关闭 thinking，另一些走默认，两者并不普遍等价。完整语义需协议级适配／请求体断言；首片限制为无推理文本模型。 |
| `extra` | 无整体等价字段 | 旧 sampling 实际传空 map。`priority` 属于旧本地队列，`timeout_ms` 是旧 completion 整体超时，均不能直接改名为 Pi 选项。Pi 0.85.1 有 `samplingParams`（如 top_p/top_k），仅部分 OpenAI 兼容 API 应用且可覆盖命名字段；旧 ChatRequest 无这些独立字段，首片不开放任意透传。 |
| `session_key`、CancellationToken | `sessionId`、`signal` | sessionId 只对支持的缓存／路由生效，不代表 Pi 持有 agent 会话。取消由 Gateway signal 接到 AbortController，见下文。 |

### 流事件与回放映射（目标边界，尚未实现）

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
| `error` 的 error／aborted、errorMessage | 业务 Error／Aborted | 保留部分内容与错误文本。同步调用、认证解析及迭代也可能抛错，不能只处理 Pi error 事件。无终态就结束按截断错误处理。DSH 的字符串错误分类和空响应判错是额外策略，不是 Pi 稳定的 HTTP 错误码。 |
| Gateway cancel／owner close | 取消 Pi signal、结束 reader | Gateway 取消后 next reject，Rust 按本地取消原因结束调用，不能等待一个必达的 Done(Aborted) chunk；超时、owner 关闭与用户取消保持不同原因。终态只能发生一次，迟到 Pi 事件丢弃。 |

用量保留 Pi 的 `input/output/cacheRead/cacheWrite/totalTokens`，以及存在时的 `reasoning`（output 子集，不能再次累加）。兼容旧 `input_tokens` 时使用 `input + cacheRead + cacheWrite`，旧 context 总量再加 output；不能照抄 DSH `inputTokens = usage.input` 就当旧含缓存 prompt 总量。`cached_tokens` 对应 cacheRead，cacheWrite 单列；`eval_tokens` 只能在明确采用未缓存输入口径时对应 input。旧 eval/output 毫秒与 TPS 没有统一 Pi 对应，不伪造；Pi 默认零值也无法可靠区分“服务端未报告”与真实零。Pi cost 来自模型目录估算，不视为账单。

回放采用“有序领域内容 + 带版本的 provider 私有元数据”方向，参考 DSH `replay.ts`：保留 api、provider、请求 model、responseModel、responseId、providerThinkingLevel 和块签名；Anthropic 的实际返回模型与请求别名要分开。Responses reasoning item 在 Pi 中由 thinkingSignature 的 JSON 字符串携带，不能把它当 Anthropic signature。旧单个 reasoning_signature／合并 reasoning_content 不足以恢复多块交错，旧 reasoning_items 也没有完整块位置。校验版本、来源与内容索引后才恢复；换模型／路由或来源不明时不得伪造同模型密文回放。旧历史迁移、凭据切换后的回放策略和持久 schema 属于后续切片。

### Gateway 所有权与已知差异

目标调用方向为 Rust agent → TS ↔ Rust napi 通信适配层 → main GatewayHost → Worker MessagePort 通信适配层 → `services/llm/` worker 内的 typed handler／Pi → 模型服务；响应 chunk 反向返回。Node `worker_threads` 是已选执行方式，utilityProcess 不在当前范围；源码位于 main 目录不表示业务在 main 主线程执行。Gateway 可双向发起响应流，并不意味着本业务需要双向 streaming RPC。当前最小契约为 `xiaowei.llm.Llm.Generate`，请求只含模型引用、独立 system prompt、单条 user 文本及采样，响应 oneof 表达文本块增量、用量和成功／失败终态。历史与工具结果回放是后续扩展，尚未加入契约；不新增 event topic 或取消 RPC。

- `services/llm/` 在 worker 内持有 Pi 适配、模型调用与在途取消；其中 `gateway.ts` 绑定 typed handler。`app/gateway.ts` 负责启动 worker、挂载 owner 和关闭。main 保持唯一 GatewayHost；worker 不另建全局 host，只持有本地执行 endpoint。Gateway worker 通信适配层属于 `gateway/ts/`，不在 LLM 内另造一套业务消息 RPC。该适配层已实现，接口与关闭约定见 [Worker 接入](../../../gateway/ts/README.md#worker-messageport-通信适配层)。service 及其执行限流、超时、流状态和实际清理整体归 worker；main 只做路由、授权和通信转发，不重复持有 service 执行配额。TS core 的 `ExecutionScope` 由 worker endpoint 和 main 本地 handler 分别持有；main 通过独立 `StreamDispatcher` 转发远端流，不另包 producer 状态机。线程两侧的消息关联、失联超时和连接关闭属于通信管理，与 service 执行状态分开。Rust 持有 agent 循环、会话、工具执行、权限、重试／恢复和落盘，不把这些迁入 TS。不开新 crate／npm workspace package，也不新增 raw napi／IPC 通道。
- 现有 `gateway/ts/src/binding/index.ts::StreamHandlers` 已给 handler 传 AbortSignal；Rust typed caller 经 napi endpoint 与 main 转发到 worker。AbortSignal 与 CallContext 不跨线程复制：取消通过控制消息触发 worker 内的 AbortController，main 保留原始上下文，嵌套调用凭与连接实例绑定的 opaque token 回到 main 授权。取消监听须在请求准备前建立，owner close、caller drop／cancel、iterator return 都终止上游并清理监听与 reader；不能只靠 async generator 的 finally 等待一个永不返回的 next。初始化失败和重复关闭沿用 main 的显式生命周期规则。
- admission、授权、超时与帧错误保留 Gateway 错误通道；已进入模型生成的 provider 失败以业务终态承载，Rust 同时处理两条错误路径。Gateway 的 open 成功只代表开流成功，不代表远端模型已接受请求。
- Gateway 限流／chunk policy 不会限制 Pi 内部缓存。Pi `utils/event-stream.js` 使用无界 push 队列且 partial 引用累积消息，pull 或额外包一层有界 Gateway 队列不构成端到端背压。首片需限制输出上限并验证取消／慢消费者清理；大输出的内存界限仍须专门解决，不能宣称已有严格有界网络背压。
- 旧 HttpBackend 有 prepare 阶段错误分类、Retry-After 和重试策略；DSH 明确 `maxRetries: 0`，由 agent 记录可见重试。首片同样单次调用、关闭 SDK 重试，之后再对齐 Rust 恢复策略，避免双层重试或重放已输出内容。
- 旧 ResponsesTransport 根据 session_key 复用 WebSocket／chain 并支持 HTTP 路径；Pi 0.85.1 的通用 `api/openai-responses.js` 走 HTTP 流，没有该 WebSocket 分支。其他 Pi API 的 transport 支持不能证明通用 Responses 等价。首片只验 HTTP/SSE，不承诺旧连接池、previous_response_id 或断线恢复语义。
- Pi error 常将异常压成 errorMessage，无法保证保留旧 HTTP status、Retry-After 和 cause。可保存实际拿到的状态／诊断信息，但不从字符串推断出可靠结构化状态；DSH 的分类仅作为参考。

### 已实现：最小 Pi 文本流

`contracts/proto/xiaowei/llm.proto` 定义 `Llm.Generate`，TS／Rust 契约已生成。`services/llm/host.ts` 创建专用 Worker，`worker.ts` 通过现有 endpoint 暴露 `gateway.ts` 的 handler；`provider.ts` 仅从 Pi 的公开 `api/openai-completions` 入口调用真实 HTTP/SSE。main 的 `app/gateway.ts` 负责接入、启动失败回收与幂等关闭，模型配置通过宿主函数参数注入并由 worker 固定快照；默认空模型列表只注册能力，不发网络请求。请求不接受 base URL 或 Key。未接设置、Key UI、工具执行、推理、历史迁移或 Quick Chat UI。

本片只支持非推理文本模型：system/user UTF-8 合计至多 256 KiB；temperature 缺省不传，显式范围 0–2；maxTokens 缺省 min(1024, 模型上限)，显式范围 1–min(4096, 模型上限)。固定 `max_tokens` 字段，关闭 SDK 重试，保留 Pi contentIndex。成功按文本增量、一次用量、一次 finished 顺序输出，finish reason 区分 stop／length；HTTP 错误和断流输出一次 failed，不泄漏原始上游响应或 Key。输入验证、超限、不支持的推理／工具输出及 Gateway 生命周期失败保留 Gateway 错误通道。

LLM 不单独覆盖并发上限，沿用 Gateway 通用默认值（owner 128 路、caller 32 路）；该值是框架资源保护，不是本片确定的业务并发策略。初版额外设置的 4／2 缺乏需求依据，已按用户反馈移除。worker 的 stream policy 设置 producer／consumer idle 各 30 秒，总时长 120 秒；适配器消费文本累计超过 1 MiB 时中止。取消监听直接连接 Pi AbortController，finally 等待 Pi result 后释放监听；挂起 next 和暂停消费均能取消 HTTP。这些限制仍不构成对 Pi 内部 push 队列的严格内存上界，慢消费者下的有界生产需后续专门处理。

Electron 构建输出独立 ESM `llm-worker.js`，内联 Gateway／契约、外置已打补丁的 Pi；普通 Node 可以执行该 worker。`pnpm --dir desktop test` 统一构建并验证真实 Pi 与本地 SSE，使用 tsx 仅加载测试的 TS 契约。同一入口的 Rust napi 测试窗口还验证 Rust typed caller → napi → main → worker → Pi：test-fixtures 内用 Envelope 包装测试入参和结果，Rust 解码为 GenerateRequest 后使用 typed StreamMethod 调用实际 Llm route，不给生产 search 添加 LLM 依赖。

真实 provider 凭据、应用包内加载及远端模型验收仍在后续范围；本地 Node mock 通过不等于 Electron 包内或真实模型验收。

### 已完成的 main 边界整理

剪贴板设置订阅、定时清理调度与服务启停统一维护在现有 `service.rs`，生命周期状态为私有 `ServiceLifecycle`；不再保留独立 `runtime.rs`。这些方法本来属于同一个 `Service`，不因后台执行而另设模块。业务 handler 的统一命名见 [Gateway 接入约定](../../../gateway/README.md#接入约定)。Storage 剪贴板 DAO handler 位于 `clipboard_dao/gateway.rs`；napi owner 注册和事件发布接线集中在 napi 的 `gateway.rs`，`lib.rs` 保留公开入口的薄委托。

剪贴板的业务 handler、资源解析与临时导出、占用统计、设置订阅、监听启停、自动粘贴与保留期限调度均由 Rust `xiaowei-clipboard` 持有。TS `services/clipboard/` 已删除，`app/gateway.ts` 仅负责实例与 endpoint 装配，初始化后调用 `startServices()`，关闭 endpoint 时先停止后台服务和监听，再清理临时资源；失败时也显式关闭 history。

Rust 先订阅 SettingsChanged，再读初始快照，避免初始化漏掉变化。启动 30 秒后开始清理，之后每次完成后等待一小时；保留期限变化立即清理，-1 跳过；保持当前普通记录定义（非收藏、无分类、无备注）与附件删除逻辑。监听及权限请求响应已提交设置，与旧版 Rust 的事件驱动方式一致；后台失败记日志，不把已提交设置回滚。初始设置加载失败会使启动失败并回收订阅。任务串行执行，关闭等待在途工作结束，避免清理依赖已经关闭的 Storage。

Select 保留原 Gateway caller，先复制并更新使用信息，经 System.HideWindow 隐藏调用方窗口并在 macOS 让出应用焦点，然后读取自动粘贴设置；开启时等待 100ms，由 Rust 发送粘贴键。普通 Copy 不隐藏或粘贴；无辅助功能权限时保留已复制内容并请求权限。macOS 粘贴实现及已有 core-foundation／core-graphics 依赖从 napi 层移至业务核心，没有新增 crate 或 npm package。

Settings 的校验、持久化和协调归 Rust。开机启动通过 System.SetAutostart，快捷键通过 Shortcuts.Apply（TS owner 位于 services/shortcuts），保留调用方权限；宿主操作失败或数据库写入失败时恢复旧值，成功持久化后才发布 SettingsChanged。原 settings apply 的 TS/napi 回调已移除，不再保留 services/settings/。ShortcutConfiguration 沿用现有 Settings 契约消息，避免改变已使用的消息全名。

迁移范围与偏差：旧版 cleanup.rs 同时执行附件完整性扫描和缓存用量更新；当前仅迁移已有过期清理调度，占用量继续按请求实时统计。完整性标记、image flow 等尚未接入，不能称为全面对齐旧版。本次沿用旧版每轮完成后等待一小时的顺序；不再使用 TS setInterval 允许清理重叠的方式。

## Alternatives considered

- 迁入旧 `crates/xw-llm/` 的协议实现：用户已明确选择复用 Pi，不再推进此方案。
- 在 renderer 中直接调用模型：无法保住当前 main／Gateway 的调用与凭据边界。

## Current work

Pi 适配边界核对、Gateway worker 通信以及 Pi 依赖／补丁引入均已完成。最小 Pi 流式调用已实现并通过自动验证；后续接宿主模型配置／凭据与应用包验收。Quick Chat UI 继续留在独立事项，不并发推进。

## Outcome

2026-09-24 完成最小 Pi 文本流切片：新增 `Llm.Generate` proto 与 TS／Rust 生成契约，接入 `services/llm/` worker 和 main 启停生命周期。支持单次 system/user 文本、temperature/maxTokens、文本块索引、最终用量、stop／length 及 failed 终态。最终复核按既定双通道区分 provider 业务失败与 Gateway 错误；取消直接中断 Pi HTTP，并等待实际结果清理。配置仅由宿主注入，默认空配置不发请求。模型目录、真实 Key、历史、工具执行及 Quick Chat UI 尚未接入。

验证通过 3 项构建产物 LLM 回归（含多组参数／失败／取消场景）、1 项 Rust typed LLM 跨语言回归及完整 `pnpm gateway:test-native`、desktop 全量测试（26 项原有 Node、3 项 LLM、64 项组件）、20 项工具回归、契约 codec、desktop build、frozen install 和最终 `just check`。覆盖默认采样、中文文本、缓存用量、唯一成功／失败终态、HTTP 错误、断流、拒绝推理／工具输出、1 MiB 超限、pending next／暂停消费取消、owner 关闭及启动失败回收。正式 napi 产物已恢复，03 Plan 已删除。未启动 Electron、未运行应用打包或真实远端模型验收；Pi 内部队列仍不是严格有界背压。新增 tsx 为 desktop 测试依赖，复用仓库现有版本，不改变产品 worker 的 JS 执行方式。

2026-09-24 完成 Pi 依赖及补丁切片：desktop 精确依赖 `@earendil-works/pi-ai@0.85.1`，原样复用 DSH 工具参数解析补丁，通过根 `patchedDependencies` 和 pnpm 生成的锁文件固定。已核对补丁与 DSH 文件一致，且可对实际安装包反向应用。两个新增间接依赖的安装脚本显式禁用：Google SDK 的 prepare 不用于已发布运行产物，protobufjs postinstall 仅提示版本声明；未启用额外 MCP 或服务。维护步骤见 `patches/README.md`。

验证通过 `pnpm install --frozen-lockfile`、2 项真实 Pi + 本地 SSE 回归（Completions／Responses 的多片中文工具参数、原始 delta 顺序、中间参数为空、最终对象及唯一成功终态）、`just check` 和 diff／手写测试行宽检查。只验证依赖与补丁，不包含产品 worker 接线、打包验收、LLM 业务契约或真实远端模型请求；另外四个被补丁修改的协议尚无本项目运行时回归。

2026-09-24 完成 Worker MessagePort 通信切片：新增 `/worker-host` 的 `attachWorker` 和 `/worker` 的 `exposeWorkerEndpoint`，支持 unary、pull 响应流、保留权限的嵌套 unary／stream，以及取消、caller cleanup、owner 替换和异常退出。worker 使用提取的 `ExecutionScope` 持有执行配额与真实清理，main 的等待结束不会提前释放其许可；本地 main 与 worker 的配额互不叠加。握手先预留后激活发布；连接错误保留原 Gateway 错误码；关闭超时明确失败并 terminate 专用 worker。线程协议及资源上限维护在 Gateway TS README。复核后补充授权后的单次预算通知，按实际 service timeout／openTimeout 约束通信等待，避免固定 15／31 秒截断长请求；可控时钟回归覆盖 20 秒开流预算和 60 秒嵌套 unary 预算。unary 保持原有同步开始 handler 的语义。直接已取消信号回归确认原实现会释放 admission 并完成 drained，不将其误记为泄漏修复。

验证通过 Gateway 类型检查、48 项 TS 测试（含 16 项真实 Worker 测试）、plain Node dist 验证、完整 `pnpm gateway:test-native`（含 Rust typed caller → napi → main → worker 的多 chunk／错误／取消／退出），以及 `just check`。正式 napi 产物已在 fixture 构建窗口结束后恢复并检查。源 fixture 使用单次 tsImport 保持模块身份；built fixture 仅使用构建后 Gateway 和原始 PB 字节，避免依赖当前只导出 TS 源码的契约包，没有改变产品构建。额外测试辅助文件属于同一测试切片，不新增 package。未冷启动或重启 Electron，未接 Pi、LLM 产品入口、事件能力或 Quick Chat UI。

2026-09-24 完成 Pi 适配边界核对：以更新后的 DSH 46a7f68b09、Pi 0.85.1 发布包及 DSH 补丁、旧版 6be131098d 为静态源码证据，明确请求／流事件映射、回放与用量差异、取消生命周期和 TS owner／Rust caller 边界。已回填 How 并删除 01 边界核对 Plan。此次只修改 record 与删除已完成 Plan；未安装 XiaoWei 依赖、定义业务 proto、实现调用、发送模型请求或运行应用。DSH 仅快进更新源码，未同步依赖或运行其测试。

已核对旧 Rust `ChatProvider` 调用入口、当前 Gateway 双向流能力、Pi 公共流事件与 DSH 适配层，并确认 Pi 包从 `@mariozechner/pi-ai` 改名为 `@earendil-works/pi-ai`。Pi 依赖及补丁已安装；尚未定义 LLM 业务契约或发送真实模型请求。

用户确认前端能力统一通过 proto service／Gateway；Electron 系统 API 由 TS System service 提供；剪贴板资源处理和占用统计归 Rust 剪贴板模块，缺失数据库信息由 Storage 提供。已将该决定及 main 全部现有文件的目标归属写入组织文档；已完成源码目录整理和启动／窗口／设置副作用拆分，保持现有业务契约与行为；System.OpenUrl 已从剪贴板 owner 中拆出；本地路径打开／定位已接入 System，剪贴板资源处理已迁回 Rust，统计与调度尚未迁移。

main 目录整理已通过 30 个 desktop Node 测试、3 个 Gateway 桌面测试、2 个生命周期／Select 测试、`just check` 与 desktop 构建。当前工作区没有运行实例，未执行冷启动；窗口运行交互仍待用户启动后验收。

合入最新 develop 后已重新通过 desktop 测试（30 个 Node、64 个组件用例）、Gateway 桌面及生命周期回归、全仓检查与桌面构建，并完成全部 napi 包 debug 构建。

System.OpenUrl 切片保持现有 HTTP(S) 协议限制，不扩大为通用 scheme 打开能力。Launcher 复用原调用 client，浏览器打开失败时不记录使用量、不隐藏窗口；系统设置专用 URL 仍仅接受 app 搜索来源。该切片不修改 proto、Rust 或 UI。

System.OpenUrl 切片已通过 `just check`、29 个 desktop Node 测试、4 个 Gateway 桌面测试、完整 `pnpm gateway:test-native` 和 desktop 构建。URL 验证测试从剪贴板辅助函数迁至 System Gateway 测试，覆盖无剪贴板初始化、与原生主题方法共存、非法 URL、宿主失败及关闭后不可调用。尚未执行本切片的真实桌面浏览器打开验收。

本地路径切片新增 System.OpenPath／RevealPath，共用 LocalPathRequest；System 校验绝对路径、NUL 字节和目标存在性。剪贴板仍在 TS 解析记录、管理临时导出，仅通过原 client 调用宿主能力；Launcher 应用启动移除 bootstrap 的 openPath 回调。已核对旧版 clipboard/commands.rs 的 open_file_path／open_large_text 和 search/commands.rs 的 LaunchApp；本次保持当前资源处理与默认应用打开方式，未宣称完成 Rust 迁移。

本地路径切片已完成 `just gen` 并通过 `just check`、契约三语言 codec 检查、Gateway 桌面行为测试、完整原生联调及 desktop 构建；三个 napi 包均已重建。用临时文件验证路径合法性、文件／目录打开、定位和宿主错误；真实 OS 应用打开与文件管理器定位仍待运行验收。

确认当前工作区活实例归属后执行 `just rs`，17:13:25 新 Electron 进程启动，原生日志、剪贴板监听和 renderer 初始化正常；具体文件打开／定位交互仍待人工验收。

资源迁移切片：Rust `resources.rs` 持有私有临时目录和原子文本导出，复用既有 tempfile 依赖（从测试依赖提升为运行依赖）；普通文本使用内容 SHA-256 命名，重新打开覆盖可能被外部修改的导出内容，图片／大文本复用原附件。关闭 endpoint 或显式关闭未完成初始化的 history 时清理导出，停止监听不清理。资源 handler 通过调用方的 Gateway client 访问 DAO 和 System，拒绝越权嵌套请求。复制路径经新增 System.WriteClipboardText 继续使用 Electron 的跨平台剪贴板；已删除 TS 资源解析实现。统计和保留期限调度仍在 TS。

资源迁移验证：Rust 剪贴板 17 项测试、desktop Node 26 项测试、完整 Gateway 原生联调（含资源处理、权限拒绝和初始化中止清理）、契约 codec 与 desktop 构建通过。临时目录权限已显式保持 Unix 0700，文件保持 0600；全仓检查需在 napi 产物事务结束后执行，避免扫描构建中的临时文件。

构建事务结束后 `just check` 已通过。确认当前工作区进程归属后执行 `just rs`，17:23:19 新进程加载三个工作区 .node，剪贴板监听、renderer 和搜索初始化正常；真实外部应用打开／Finder 定位仍待人工操作验收。

占用统计切片：新增 `xiaowei.storage.Storage.DatabaseUsage`，由现有 Storage endpoint 报告自身数据库／WAL／SHM 的文件长度总和；Rust 剪贴板保留原请求权限调用该契约，再在 blocking worker 递归汇总附件目录中的普通文件。缺失文件计零，其他文件系统错误向上传递，不跟随符号链接；保持整个共享数据库加附件的原口径，不做业务空间分摊。TS 统计实现及数据库路径参数已移除，临时导出文件不进入附件目录。

统计切片已通过 Rust 剪贴板／Storage 41 项测试、desktop Node 25 项测试、完整原生联调及新增占用统计跨语言测试、三语言 codec 和桌面构建。覆盖 WAL／SHM、缺失文件、目录递归、符号链接、附件删除、导出不计入附件及权限／Storage 关闭错误传播。

统计切片的 `just check` 已在构建结束后通过；确认工作区实例归属并执行 `just rs` 后，17:29:46 新进程加载三个原生模块，剪贴板、renderer 和搜索初始化正常。设置页实际空间显示仍待人工验收。

HMR 修复已于本轮前经用户人工验收：设置页热更新后，加载设置和刷新存储空间未发现异常。相关约束在 renderer、main README 及 Biome 中维护。

本轮完整边界迁移已通过 Rust 剪贴板／Storage 43 项测试、desktop Node 26 项测试、完整 Gateway 原生联调、三语言契约 codec、desktop 构建和 `just check`。新增回归覆盖：30 秒初次清理及小时周期、重复启动／关闭、永久保留、收藏保护、关闭后停止清理，Select 的复制／隐藏／粘贴顺序与失败短路，以及 Settings 嵌套调用权限和宿主失败回滚。三个 napi 包均完成重建。

确认当前工作区活实例后执行 `just rs`，18:11:04 新 Electron 进程加载三个工作区原生模块，Rust 设置订阅启动、剪贴板监听和 renderer／搜索初始化正常。真实自动粘贴与焦点恢复、修改快捷键和开机启动仍需用户人工验收；未在用户系统上自动切换这些设置。main README 已移除业务细节与历史进度，只保留能力归属、装配、生命周期和开发导航约定。

模块命名与归属整理已完成：移除 clipboard `runtime.rs`，其实现及周期测试合入 `service.rs`；Storage DAO handler 和 napi 接线归入各自的 `gateway` 模块。43 项 Rust 测试、完整 `pnpm gateway:test-native` 和 `just check` 通过，正式 napi 产物已重建。确认工作区实例后执行 `just rs`，18:27:44 新 Electron 启动，剪贴板监听与 renderer 初始化正常；本轮不改变契约或业务行为。
