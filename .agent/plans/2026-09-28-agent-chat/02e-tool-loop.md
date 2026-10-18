# 02e：工具循环与有序结果

前置：[当前文本聊天基线](../../records/active/2026-09-28-agent-chat/implementation-results.md#持久文本聊天里程碑)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：harness 按首次基线与后续增量同步指令／工具；Agent runtime 能处理工具声明、合法 TOOL_USE、顺序执行和结果闭合后继续模型生成。

范围边界：测试工具仅验证循环；文件、Bash、WebFetch 和用户交互由后续各片真实交付。2026-10-10 用户确认暂缓 preset，技能后移；本片先集中接好提示词和实际工具，不增加 preset 身份／注册目录或技能加载工具。

接入预验已完成：[Pi provider 请求编码实测](../../records/active/2026-09-28-agent-chat/model-types.md#pi-provider-请求编码实测2026-10-10)的 12 项测试确认默认折叠、开关启用后的变化表达及删除／同名替换回退。当前 PB 与应用配置仍不能接入这些更新；此结果不代表同步机制或工具循环已实施。继续时复用该证据，先处理已确认的映射缺口，不重复从默认行为猜测模型能力。

2026-10-11 [最小适配实验](../../records/active/2026-09-28-agent-chat/model-types.md#最小适配实验2026-10-11)另通过当前默认 sol／Responses 的六次真实调用与三项本地测试：明确的变化通知可保留，模型按新增／替换定义调用，并遵循移除和指令更新。该方案的 API tools 仍为完整当前集合；生产接线、其他 provider 和缓存收益未验证。

## 文件与改动

以下只列剩余预计改动；已完成的核心记录与恢复见[交付说明](../../records/active/2026-09-28-agent-chat/model-types.md#系统上下文核心记录与恢复2026-10-18)。2026-10-18 用户确认聚焦 Agent 核心，先实现领域状态、提交／恢复与工具循环；provider 原生增量和缓存实验不再作为这些工作的前置。领域表达由 harness 已确认的语义决定，Pi SystemMessage 仍只是适配候选。正式接入仍须验证有序更新不会被折叠，不将完整 tools 回退视为已完成增量要求。

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `crates/xw-agent-runtime/src/text.rs、generation.rs` | 加入当前需要的工具接口、循环和限额；不依赖 Gateway |
| 新增 | `crates/xw-agent-runtime/src/agent_loop/{mod,run,tool_execution}.rs` | 迁移旧循环并接现有文本生成；顺序工具执行、参数错误与取消结果闭合 |
| 新增 | `crates/xw-agent-runtime/src/tools/mod.rs、tool_params.rs、ui_description.rs` | 工具注册接口、JSON 参数校验与实际 UI 描述 |
| 新增 | `crates/xw-agent/tests/tool_loop.rs` | App Server 下的工具 Item 关联／变化测试 |
| 新增 | `crates/xw-agent-runtime/tests/tools.rs` | 确定性工具循环、非法参数、上限和取消测试 |
| 新增 | `crates/xw-agent/src/tool_registry.rs` | 集中装配实际工具声明与执行器，模型可见集合和执行允许集合保持一致；本片生产注册为空，不发布测试工具 |
| 修改 | `crates/xw-agent-types/src/message.rs、rollout.rs、format.rs、validation.rs、lib.rs` | 在已有独立系统记录上接有序模型消息投影，保留指令／工具更新相对输入与回复的位置；保持既有历史可读 |
| 修改 | `crates/xw-agent-types/src/generation.rs` | 生成请求消费含系统基线／增量的有效消息历史；执行工具集合与重建状态一致，避免同时用顶层字段重复注入基线 |
| 修改 | `crates/xw-agent/src/context.rs、execution.rs、persistence.rs` | 在生成边界接现有差异与提交入口，成功后组装实际请求；跨 Run、重开与内存模式保持相同同步语义 |
| 修改 | `contracts/proto/xiaowei/llm.proto` | 表达按序的系统上下文更新；依据接入验证确定 ChatMessage 扩展与字段，不用独立顶层全量字段冒充变化记录 |
| 修改 | `desktop/src/main/services/llm/worker/messages.ts` | 验证并实现系统更新的 provider 映射，候选为 Pi SystemMessage 的 sections／toolsAdded／toolsRemoved；系统历史不与顶层简写重复注入 |
| 按验证结果修改 | `desktop/src/main/services/llm/worker/provider.ts、shared/model-compat.ts` | 核对实际 provider 的折叠与工具解析条件，修正必要的配置／适配缺口；不将默认值当作模型能力结论，不为未知 provider 预建通用兼容框架 |
| 修改 | `crates/xiaowei-agent/src/generation.rs、message_codec.rs` | 将按序的系统基线／增量消息传给 Llm.Generate；工具声明保留名称、描述、参数和额外契约信息 |
| 修改 | `crates/xiaowei-agent/tests/message_codec.rs`、`desktop/tests/llm/messages.test.mjs、provider.test.mjs` | 验证系统基线／增量往返，并沿正式 worker 和实际 Pi provider 捕获最终请求；覆盖片段移除、工具增删与定义替换，不只验证 provider 入口收到有序历史 |
| 修改 | `crates/xw-agent-types/tests/format.rs、validation.rs`、`crates/xw-agent/tests/recovery.rs` | 扩展有序模型消息投影、执行入口与工具循环的恢复验证，覆盖无变化、增删和提交失败不调用模型 |
| 修改 | `crates/xw-agent/src/execution.rs、events.rs、persistence.rs、recovery.rs`、`crates/xiaowei-agent/src/gateway.rs` | 工具事件转公共 Item 视图，保持 Run／Turn／Gen／provider call ID 关联，Gen 结束后工具 pending 时继续保持 Turn 活动 |
| 修改 | `contracts/proto/xiaowei/agent.proto` | 加入实际工具公共视图；内部意图／结果直接消费 01a 的 ToolIntent／ToolOutcome／ProviderToolKey，保留 metadata／usage，复用当前领域类型与 compact codec |

## 实施顺序

提示词与工具在 xw-agent 集中管理，按 [Harness 能力上下文同步](../../records/active/2026-09-28-agent-chat/model-types.md#harness-能力上下文同步已确认待实施)写入首次基线及后续增量。XiaoWei 自己实现 harness，只调用 Pi LLM provider。初次不是每个 Run 的首次；无变化时不追加配置。技能后移，preset 不作为前置。

1. 将已验证的核心同步入口接入生成边界，扩展 GenerationRequest 的有序上下文、领域消息投影及必要适配。PB／worker 的改动围绕该核心语义实施，不反向以 Pi 字段定义核心；检查 normalizeContext 不重复注入基线。正式生产启用必须通过完整接入路径的更新语义验收，失败时定位适配缺口，不静默折叠或降级。
2. 核对旧顺序工具执行及默认每 Run 50 次限制，实现工具接口和循环。仅完整有效 TOOL_USE 才执行，LENGTH 不执行截断参数；工具声明与执行器由同一注册结果装配。
3. 拆开现有 record_end 同时结算 Gen／Turn／Run 的路径。模型 TOOL_USE 完整结束时先结算 Gen，工具意图在副作用前提交，结果闭合后才结算 Turn，后续生成另开 Turn；结果提交失败不得继续生成。不把一次 TOOL_USE 当 Run 完成；工具参数 delta 与最终参数分开，耗时缺失不伪造零值。
4. 未知或未开放工具、参数错误、执行失败返回关联错误结果；取消结算已完成结果和未执行项，禁止停止后下一次 Generate。用确定性 Host 和真实临时副作用验证闭环，再接公共工具 Item 与正式产品链路。
5. 模型适配阶段复用既有请求编码证据，并按实际需要验证 CLIProxyAPI→Codex 的 additional_tools／Responses Lite 表达；缓存收益独立测量，不阻塞前述核心状态机实施。不可把客户端请求字段当作上游实际收到的字段，也不可把传输续接等同 KV cache。

## 当前下一步：接入生成边界

核心记录、差异计算、提交和恢复已实现并验证；实现说明与测试证据回填 record，不保留重复实施步骤。实际实现直接复用 Journal 权威记录，未增加 Session 同步缓存。接下来修改 execution／persistence 与 GenerationRequest，按历史顺序将已提交系统记录投影进生成请求；确定性 Host 验证提交失败不生成、首次基线与跨 Run 无变化不追加。随后贯通正式 PB／worker，才启用生产同步。

系统提示词正文由 xw-agent 按实际能力维护；旧版聊天入口的 static／dynamic 均为空，环境 attachment 是另一条链路，来源核对见[record](../../records/active/2026-09-28-agent-chat/model-types.md#系统上下文核心记录与恢复2026-10-18)。先编写实际基础行为说明，工具规则仅随真实工具注册接入，不提前宣称技能、权限交互或后台执行可用；工具 schema 保留结构化声明，不在正文重复维护。当前合成指令只用于核心测试。

## 独立验收

- runtime／xw-agent 工具测试及相关格式／check；契约生成和漂移检查。验证非空指令与工具声明到达正式 adapter，模型可见与可执行集合一致，未开放工具不能执行；检查模型可见历史中的真实基线／增量，不以网络续接测试代替。
- 首次仅一份基线；多次生成／跨 Run 无变化时不追加系统记录；新增、删除及同名工具 schema 变更仅追加对应变化；重开恢复后不重复注入；记录提交失败不调用模型；重建后的工具集合与执行集合一致。
- 正式 worker → 实际 Pi provider → 请求捕获的集成验证覆盖完整样例，检查更新位置、内容和当前可调用工具集合；只 mock 网络响应，不用替换 provider 转换的入口 mock 代替。请求捕获证明编码行为，目标接口实际接受的字段和模型调用行为仍需相应联调，不据此宣称所有模型均支持。
- 确定性 provider + 有真实临时副作用的测试工具验证 call → result → 下一次模型调用、顺序、50 次边界、GenEnded 后 Turn 工具 pending、工具结果提交后 TurnEnded 和各阶段取消。后续 steering 的工具间检查／skipped 闭合规则已在 01a 定义，本片不实现排队入口。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
