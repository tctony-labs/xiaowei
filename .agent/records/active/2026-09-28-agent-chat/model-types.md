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

本文与[历史格式](history-format.md)共同描述当前领域类型与 v2 磁盘表示。文本与首批文件工具已接生产；交互、压缩和继续运行的结构已有定义及 fixture 校验，实际执行仍由后续切片实现。types 是内部领域包，公共 Request／Response／Event 在 agent.proto。

### 源码基线与采用范围

| 来源 | 核对文件／实体 | 本次采用与限制 |
| --- | --- | --- |
| 旧 Rust `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` | `crates/xw-agent-protocol/src/{message,rollout}.rs`；`xw-agent-session/src/{lib,local}.rs`；`xw-agent-app/src/interactive.rs` | 迁移消息、JSONL、工具记录、预算和压缩语义；保留 JSONL 语义，SQLite 由 xw-agent 自管，旧格式不导入 |
| 当前 XiaoWei | `contracts/proto/xiaowei/llm.proto`；`desktop/src/main/services/llm/worker/{messages,events}.ts` | 以实际 PB 字段和 worker 校验为模型边界，不能把“可序列化”当成“可用于 Generate” |
| Codex `b741e480e203f037ca726bc2a76d99a8e8668e66` | `codex-rs/history/src/lib.rs` 的 `ResponseItemEnvelope`／`RolloutItem`／`RolloutLine`；`protocol/src/{models,protocol}.rs` 的 `ResponseItem`／`SessionMeta`／`TurnContextItem`；App Server 的 `ThreadItem`／`TurnSteerParams` | 采用稳定实体身份、历史顺序、配置归属和输入目标边界；不复制 OpenAI 专有 ResponseItem 联合或宣称 wire 兼容 |
| 已安装 Pi AI `0.87.1` | `desktop/node_modules/@earendil-works/pi-ai/dist/types.d.ts` | 当前模型实际消费基线；SystemMessage、deferred、diagnostics 等上游字段不等于本项目已支持 |
| Pi 最新参考 `11449730c8a733953ce1bcce70e066bccaa778a5` | `packages/agent/src/types.ts`；`packages/coding-agent/src/core/session-manager.ts` 的 `SessionHeader`／`SessionEntryBase`／`CompactionEntry` | 采用模型历史转换与运行状态分离、压缩边界／来源；不提前建设分支 DAG 或迁入 TS Agent |

### 内存上下文与最小持久信息

**完整 RuntimeRunContext 在内存中组装，不整体持久化。** 消息和工具结果从历史重建；权限从已提交决定重建；当前指令／工具状态从独立系统记录重建，工具执行器按当前会话 cwd 和已提交授权组装。取消句柄、provider／工具实例、连接、队列对象、缓存和进程句柄只在内存中，恢复时重新创建。重放指重建状态，绝不重新执行历史模型或工具。

`RunContext` 嵌在 RunStarted 中，Conversation Gen 继承所属 Run；辅助标题／压缩／工具提取 Gen 携带自己的必要配置。没有独立 ContextDefined、ContextId 或 preset 配置引用；完整指令保存在独立系统上下文基线／变化中，不在每个 Run 中重复保存。完整内存上下文由历史和必要执行参数组装，外部设置不整体落盘。[Preset 已暂缓](agent-presets.md)，不新增 RunContext.agent；连接／资源句柄继续仅驻内存。

Run 只锁定 Agent 选择的 model_ref／reasoning 与 Agent 自己的运行配置；不检测 LM worker 中同引用的配置变化，原配置 token 设计已撤回。Meta 与 Run 配置分别保存 host 提供的 provider_name／model_name（例如 tctony 与 sol），使历史展示独立于当前模型列表；不保存预先拼接的名称，只在最终展示层格式化。凭据、认证 headers、带凭据的连接地址和完整 ModelConfiguration 不落盘；provider 默认值若当前接口未暴露，保持未显式指定。这套格式用于恢复领域历史与说明当时的选择，不承诺重新发送完全相同的 HTTP 请求。

### Harness 能力上下文同步

2026-10-10 用户明确要求：harness 向模型同步工具、指令及以后技能的变化，采用“完整基线＋后续增量”。这决定模型可见上下文如何构成，不能交给 WebSocket 续接、网络去重或提示词缓存来代替实现。preset 暂缓不影响这一要求；当前先接提示词与工具，技能实现后移。

| 时机 | Harness 写入当前模型上下文的内容 |
| --- | --- |
| 首次建立上下文 | 当前指令与完整可用工具声明；未来有技能时包含技能简介目录，正文仍按需加载 |
| 普通后续生成，能力没有变化 | 不追加系统配置记录，复用已有基线与变化历史 |
| 指令或工具发生变化 | 只追加有变化的指令片段、新增／移除工具；同名工具定义变化按移除旧定义再加入完整新定义表达 |
| 压缩并建立新的上下文 | 用权威当前状态建立一份新基线，再继续累积后续增量；不把旧基线和全部旧增量重复塞入新上下文 |
| 重开／恢复 | 从已提交历史恢复同步基线；基线有效时继续比较差异，基线确实缺失或被上下文替换时才补全量 |

首次是“模型上下文的首次”，不等于每个 Run 的首次。每次生成可检查当前状态与已写入上下文状态的差异，但检查本身不生成记录。变更先在明确的生成边界提交，再用于后续生成和工具执行；写入失败不能推进已同步基线或继续生成。声明与执行共享生效工具集合，移除工具不能只通知模型却继续开放执行。

XiaoWei 自己实现 harness，决定基线、差异、顺序、提交和恢复；只调用 `@earendil-works/pi-ai` 0.87.1 的 LLM provider，不使用 Pi Agent／harness。provider 的转换行为是接入时需要验证的事实，不能反过来决定核心何时重写上下文，也不能仅凭默认兼容配置断言模型接口不支持某种更新。

当前 AgentMessage／ChatMessage 已加入 SystemContext 更新投影；生产请求按顺序传递基线／增量，不再只依赖顶层简写。核心记录／恢复与正式接线分别见下节。系统更新由 harness 产生，不记作真实用户输入或模型生成的 Message，也不借 preset 引入新的身份体系。领域记录、持久化编码与 provider 消息结构分别承担自己的职责，不因 Pi 暴露某个字段就要求逐字段照搬到领域与 PB。

正式接线将系统上下文记录映射到 Pi SystemMessage：首条提供基线；后续 sections 替换／删除指令片段，toolsAdded／toolsRemoved 表达工具变化。下述请求编码及真实模型实测明确了当前支持边界，见[正式接线](#正式生成接线与适配边界2026-10-18)。可变指令按变化片段更新，新增／替换工具携带完整定义；比较定义内容，避免对象地址或 JSON 键顺序变化产生伪增量。

采用该映射时，Agent 路径不能同时经顶层 system_prompt／tools 简写再向 Pi transcript 注入一份相同基线；其他 LLM 调用方的现有简写继续按既有语义处理。这不等于禁止 provider 按 API 契约生成顶层 tools 字段，也不代表该字段可以仅传变化部分。RunContext 的执行元数据与模型可见的同步记录分工独立，不把每 Run 的工具快照重复追加到模型历史。

源码核对到的接入事实：worker 的 `provider.ts` 先调用 normalizeContext，再调用 Pi provider；normalizeContext 只把顶层简写转成首条系统消息。Pi 的 `utils/transcript.js` 另有 collapseSystemMessages／resolveTranscript，可将变化折叠成当前首条系统消息；OpenAI Responses provider 按 supportsMidConvoSystemMessages 决定是否折叠，默认值为 false。resolveTranscriptTools 在不满足增量条件或出现删除／重声明时会取当前完整工具集合。这些转换确实存在于 provider 包，不以使用 Pi harness 为前提；但它们不足以证明目标模型／API 的固有限制，也不能证明只打开一个开关就满足全部更新语义。

自动验收分两层：先验证 harness 首次只有一份全量基线，无变化的生成／跨 Run 不增加记录，增删和 schema 变更只产生对应增量，重建状态等于权威状态，压缩／重开正确恢复，提交失败不生成。再沿正式 worker → 实际 Pi provider 路径检查最终请求中的指令位置、更新内容和生效工具定义，覆盖新增、删除及同名替换；PB 往返、provider 入口 mock 或 WebSocket 续接测试均不能单独证明这层语义。工具声明的 API 字段与变化通知是否分别需要表达，应由该验证确定。

2026-10-18 用户确认优先实现 Agent 核心，provider 原生增量与缓存实验不作为核心实施前置。此范围随后已随 02e＋文件工具提交：领域状态、差异、持久化／恢复、正式映射和工具循环已接通，具体支持边界见下文。字段不直接照搬 Pi；不符合要求的更新明确拒绝，不默认为已获授权的全量降级，也不重新询问既定 harness 策略。技能恢复实施时再补简介目录增量及已加载必要指令在压缩后的恢复验收。

#### 系统上下文核心记录与恢复（2026-10-18）

02e 首步已新增 `xw-agent-types/src/system_context.rs` 与 `xw-agent/src/context_sync.rs`。types 提供 SystemContext／SystemContextDelta／SystemContextUpdate 及纯状态转换；核心 `plan_system_context_update` 计算基线／差异，`sync_system_context` 直接复用 Journal 的已提交记录与 append，不另加 Session 同步缓存或存储抽象。恢复以现有 ContextBoundary 为上界，`RebuiltContext.system_context` 区分尚无基线与空基线。磁盘字段和检查点语义只在[历史格式](history-format.md#系统上下文记录核心记录恢复已实现)维护。

同名工具 schema 或描述变化只移除并加入该工具；工具列表顺序、JSON 对象键顺序或空白变化不产生伪增量，数字比较不经过 f64。首次基线、无变化不写、增删替换、空基线、关闭重开、跨 Run 和既有检查点恢复由临时 JSONL／固定历史验证。写入前、半行、完整行未确认和 sync 失败四种注入均验证已提交状态不前进，修复后仍计算相同变化，不自动重试或调用模型。新增测试为 `xw-agent/tests/context_sync.rs` 的 8 项与 `xw-agent-types/tests/system_context.rs` 的 6 项，均已通过。

最终验证：types／rollout／runtime／xw-agent／xiaowei-agent 合计 137 项 Rust 测试通过；五包 all-targets、no-deps 严格 Clippy 通过；正式 xiaowei-agent napi 的 build:debug 与 just check 通过。仅使用临时目录与合成内容，没有真实模型调用、修改应用配置或启动应用。

`39b7bb5` 只交付本节的核心记录／恢复，当时尚未接生产生成边界；AgentMessage／LLM PB／worker 投影和工具执行随后由 `cc2f049` 接通，见[正式生成接线](#正式生成接线与适配边界2026-10-18)。自动压缩仍未实现，核心检查点恢复测试不代表自动压缩已交付。

系统提示词来源纠正：此前用旧仓库 `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` 的 `xw-agent-app/src/{send,interactive,agent_manager}.rs` 中空字符串推断生产正文不存在，属于误读测试工厂，撤回该结论。生产 `xiaowei/studio/src/biz/chat/mod.rs` 的 ChatManager::init 创建 ChatAgentFactory 并交给 AgentManager；`chat/agent_factory.rs` 的 create_agent 注入 build_static_system_prompt、默认动态指引加 merged_rules_text，以及实际 bundle 的动态片段。完整静态正文由该文件维护，包含小微身份、中文风格和工具规则；`bundle/filesystem.rs` 另提供 home 目录片段。runtime 再拼接基础与动态片段；环境／会话 attachment 属于另一条链路，不能代替生产提示词来源。

#### 系统提示词正文与片段装配（2026-10-18）

用户确认以旧版生产正文为迁移起点，保留小微通用助手身份、始终中文、简洁直接和无 emoji；增加已授权任务持续执行、必要澄清、真实结果与验证的行为要求。“每轮文字回复”明确为用户任务交付时总结，允许中间只生成合法工具调用。系统指令依据真实来源，不因普通文本包含 system-reminder 标签而提升权限。

基础正文唯一维护于 `crates/xw-agent/src/prompts/base.md`；`prompts/mod.rs` 的 `build_chat_system_context(tools)` 将其装配为稳定的 `base` 片段，只为调用方实际传入的 Read／Write／Edit 声明加入 `tool.Read`／`tool.Write`／`tool.Edit` 片段。规则分别独立，不依赖 map 字典序覆盖其他片段；工具定义保持原值，结构和重复名沿用已有校验。这个入口不注册工具、授予权限或提交记录，后续仍由注册结果、sync_system_context 和生成边界接线负责。

第一批规则保留专用工具优先、按需分页读取、了解既有内容后局部编辑，以及约 8000 字符或 200 行的大参数分批建议；这是降低流式截断风险的指引，不是 schema 硬限制。description 首字段及旧卡片标题要求等待实际 schema／UI 核对。Skill／Todo／交互／网页／后台规则均随对应能力后续接入，本次没有提前加入基础正文。

本次未迁移应用／项目 rules 发现与加载，也没有注入未经核实的 Python 环境、写入范围、cwd 或模型身份承诺。旧环境 attachment 中每轮当前时间、日期变化等频率本次不调整；环境链路接入时另核对，不宣称已全面对齐。生产 start_run、PB／worker 的有序投影已接通，基础正文与实际工具规则进入真实模型请求；本批另注入实际 cwd 及基础写入权限说明。

2026-10-25 接入前台 Bash 时只增加对应声明和 tool.Bash 片段，保留上述基础正文与三个文件工具 schema。旧会话的增量升级及未变化／重开不重复已有回归，具体状态和验证见 [Bash 交付结果](implementation-results.md#前台-bash-与-macos-沙箱2026-10-25)。

装配子步骤新增 `xw-agent/tests/prompts.rs` 的 3 项测试，沿实际装配→Journal 提交／恢复入口覆盖仅声明可见工具的规则、原样保留声明、工具与规则同时增删、重开后不重复基线和写入失败保留旧状态；当时 xw-agent 全部 71 项测试、严格 Clippy、正式 Agent napi 构建和 just check 通过。该子步骤已包含在 `cc2f049`，后续真实模型与产品验证统一见[交付证据](implementation-results.md#工具循环与文件工具2026-10-18)，不保留“未提交”的中间状态。

#### 正式生成接线与适配边界（2026-10-18）

`tool_registry` 根据会话实际 cwd 装配 Read／Write／Edit、macOS Bash 声明、基础正文、对应工具规则及环境片段。生成前先提交独立系统记录，恢复得到按时间排列的 `AgentMessage::SystemContext { update }`；有检查点时由快照建立新基线。领域 JSON 将 update 嵌套保存，避免与消息角色的 type 标签冲突；PB codec 覆盖基线和增量往返。普通持久 Message 仍不能写入这一角色。

正式 LLM PB 增加 `ChatMessage.system_context`，worker 校验基线位置、具名片段和工具变更，并拒绝同时重复传入顶层 systemPrompt／tools。Responses、Completions 的适配开关由 worker 设置；Anthropic 的已知编码会移动增量位置，故与其他未验证 API 一样，遇到实际增量明确拒绝。各 API 的单次基线不受此门禁影响。Responses 的基线、工具新增、指令更新、无变化及重建基线已通过真实配置模型的五次正式 provider 调用；HTTP 捕获确认旧基线和新增项的历史位置。

工具删除／同名替换目前在正式 provider 入口明确拒绝。Pi 原生路径会折叠为当前完整 tools；另试验稳定初始 tools 加 additional_tools 和替换通知时，实际默认 Responses 模型仍返回旧 text 参数，而非新 count 参数，故未启用该试验适配。此限制属于当前适配实现，不作为模型／API 固有限制的结论；核心领域、提交、恢复仍支持完整增删替换。固定 Read／Write／Edit 在本批运行中不变化，因此不触发此限制；后续动态工具／Skill 接入前须解决并重新联调，不偷偷回退为全量 tools。其他 provider 的实际增量及缓存收益未完成联调。

可重复验证：`XIAOWEI_AGENT_LIVE=1 pnpm --dir desktop exec node --conditions=source --import tsx --test tests/llm/harness-context.test.mjs`。仅发送合成提示和无副作用探针；不改配置，不输出凭据。工具循环的正式 addon／Gateway／worker 验收另见[交付证据](implementation-results.md#工具循环与文件工具2026-10-18)。

#### Pi provider 请求编码实测（2026-10-10）

本节保留接入前的实验依据；当时的 PB／配置缺口随后部分由正式 worker 适配补齐，当前支持范围以上面的正式接线说明为准，不将旧实验当作尚未接线的结论。

验证入口：[context-updates.test.mjs](../../../../desktop/tests/llm/context-updates.test.mjs)。使用 worker 的 toPiModel、apis 选择与 normalizeContext，调用已安装 Pi 0.87.1 的真实 stream／streamSimple；仅替换 SDK 的 fetch，捕获实际序列化请求并返回固定 400 结束调用。使用合成配置与消息，无真实凭据、无外部模型调用、未修改运行逻辑。测试里的显式开关直接传入 provider，不能视为当前应用设置已经支持。

| 路径与条件 | 实际请求结果 |
| --- | --- |
| Responses、Chat Completions、Anthropic，默认兼容配置 | 更新合并到首条／顶层系统指令，工具取当前完整集合；历史里的指令更新位置不再保留 |
| 三条路径，启用 supportsMidConvoSystemMessages | 保留旧指令基线，后续出现按名称替换／删除片段的文字通知；不是原样传输 sections 对象 |
| Responses，再启用 supportsAdditionalTools，只有工具新增 | 初始工具在顶层 tools，后续新增在 additional_tools 项中；已覆盖 streamSimple 路径 |
| Responses，同一历史出现工具删除或同名替换 | 顶层 tools 改为当前完整集合，原有 additional_tools 也不再输出；仅有工具变化的更新不会自动变成文字删除通知 |
| Chat Completions，启用系统更新及工具新增开关，同名 schema 替换 | 使用当前完整 tools，消息中没有对应工具增删项 |
| Anthropic，启用系统更新及工具变化开关，有初始工具且无同名重定义 | 请求包含 tool_addition／tool_removal；后加入的工具定义在顶层列表中标记 defer_loading |
| Anthropic，同名 schema 替换 | 改用当前完整 tools，不再输出工具增删块 |
| Anthropic，系统更新位于两条 user 消息之间 | 更新移动到后一条 user 消息之后；保留更新不等于保持全部原始位置 |
| 当前 XiaoWei 契约／配置校验 | worker 拒绝 system 消息；应用配置拒绝上述中途系统更新开关，不能通过现有配置直接启用 |

运行 `pnpm --dir desktop exec tsx --conditions=source --test tests/llm/context-updates.test.mjs`：12 项通过。测试证明 provider 的编码行为，以及当前接入缺口；未验证远端 API 接受这些字段、模型遵循更新的行为，也未覆盖其他 API、reasoning 模式或全部兼容开关组合。

该实验说明不能直接把 SystemMessage 映射判定为满足全部同步要求。后续正式适配已接指令更新与新增工具，并明确拒绝尚未可靠支持的删除／同名替换；不能把“顶层 tools 等于当前集合”当成“模型已收到按时间出现的变化”。既有 harness 基线／增量决定保持不变。

#### 最小适配实验（2026-10-11）

本节是早期候选实验，未作为最终生产方案启用；执行器现状和拒绝门禁见[正式接线](#正式生成接线与适配边界2026-10-18)。

用户同意先验证最小表达，再扩展契约。实验入口为 [verify-context-updates.mjs](../../../../desktop/scripts/verify-context-updates.mjs)，调用方式见 [验收脚本](../../../../desktop/scripts/README.md#上下文变化的最小适配验证)。复用 worker 的 toPiModel、apis 与 Pi streamSimple，直接提供合成上下文；没有改变生产代码、PB、历史格式、已保存配置或真实会话。

实验选择配置中的全局默认模型 `sol`／openai-responses，不代表所有已有会话的独立选择。仅在内存中启用 supportsMidConvoSystemMessages，关闭 supportsAdditionalTools／supportsToolSearch，以 SSE、low reasoning 调用；凭据从应用既有加载器读取并仅发往该配置的接口。

候选表达分工：harness 的增量消息明确写出移除名称和新增／替换的完整定义，并在同一更新中维护 Pi 的 toolsAdded／toolsRemoved 状态；指令片段仍由 sections 映射成具名更新通知。这样工具状态即使被 provider 解析成顶层当前集合，变化通知也不会随之消失。首次基线一次、后续消息只含变化，无变化不追加，重建时丢弃旧更新并建立当前基线。

六次真实调用全部通过：

| 场景 | 观察结果 |
| --- | --- |
| 初始基线 | 调用 probe_echo，参数为 `{ "text": "seven" }` |
| 新增工具 | 调用新加入的 probe_lookup，参数为 `{ "key": "sample" }` |
| 同名 schema 替换 | probe_echo 改为 `{ "count": 7 }`，没有沿用旧 text 字段 |
| 移除工具并替换指令片段 | 未调用已移除的 probe_lookup，准确回复新的 `UNAVAILABLE_NEW` |
| 无变化继续 | 不追加系统更新，仍准确遵循新指令且不调用已移除工具 |
| 重建基线 | 仅保留当前基线，仍按新 schema 调用 probe_echo |

本地 [context-adaptation.test.mjs](../../../../desktop/tests/llm/context-adaptation.test.mjs) 的 3 项自动测试通过：实际 provider 编码保留基线和独立增量、不重复追加或混入无关定义；无变化与重建行为正确；模拟模型仍调用已移除工具时实验失败；不支持的 API 在请求前拒绝。已有 provider 编码测试 12 项仍作为独立依据。

边界：此次证明该目标接口接受这种消息表达，并观察到一次完整实验中的遵循行为，不保证所有模型或未来每次采样均遵循。模型可读的变化通知是增量，但请求 tools 仍为完整当前集合；既不能把消息增量宣称成原生工具声明增量，也不能承诺完整请求缓存前缀稳定。实验没有量化 token／缓存收益，未验证原生 additional_tools 路径。执行器仍必须独立按生效工具集合和 schema 校验，不能依赖模型自觉；实验仅有固定工具结果与基本允许集检查，生产执行防线尚未实现。

该实验没有解决顶层 tools 变化带来的工具声明增量和前缀稳定问题，故未将“文字通知＋完整 tools”作为最终方案。2026-10-18 后续已按结构化领域更新实现持久化／恢复和正式接线，不以这些缓存实验阻塞核心工具循环；删除／替换的 provider 适配、缓存收益和实际自动压缩仍为后续事项，其他 provider 的能力不能据此推定。

#### sol 实际请求链路核对（2026-10-11）

按用户要求只读核对本地模型配置、线上部署与对应源码：显示 provider 为 tctony，provider 标识 custom，api 为 openai-responses；配置启用 WebSocket／auto，没有 compat 覆盖或 Responses Lite header。请求经过 token.edge.tctony.com 的 CLIProxyAPI，线上容器版本为 `81e9a1c67bd74169b23772ee848b215e4e8ee1db`，服务端 alias 将 sol 映射到 codex 通道的 gpt-6.1-sol。Codex executor 的默认上游为 `https://chatgpt.com/backend-api/codex/responses`；本次未抓取选中凭据的最终上游请求，不能把源码默认地址视为对所有凭据覆盖的实测。

Pi 0.87.1 的 Responses 默认关闭中途系统消息、additional_tools 和 tool search；tools 由当前集合生成。现有 WebSocket 补丁的 getCachedWebSocketInputDelta 先比较 input／previous_response_id 之外的全部请求字段；tools 变化会使比较失败，清除本次续接基线并发送完整请求，而非发送 previous_response_id＋input delta。这是传输续接行为，不能直接等同上游 KV cache 全部失效。

部署版本的 [Responses→Codex 转换](https://github.com/tctony/CLIProxyAPI/blob/81e9a1c67bd74169b23772ee848b215e4e8ee1db/internal/translator/codex/openai/responses/codex_openai-responses_request.go#L15)保留 input／tools 的主体表示，进行 system→developer、内置工具名称等兼容处理；没有将两次完整工具集合自动 diff 成 additional_tools 的机制。executor 另有 schema 规范化，以及满足条件时补入 image_generation 的逻辑，不能把客户端请求直接当作上游最终请求。

代理通过 header 或 client_metadata 中的 [Responses Lite 标记](https://github.com/tctony/CLIProxyAPI/blob/81e9a1c67bd74169b23772ee848b215e4e8ee1db/internal/util/codex.go#L11)识别原生路径；该版本已有保留 additional_tools、无顶层 tools 的本地测试，但当前 XiaoWei 请求不携带该标记。本次没有通过真实调用验证 Lite 新增／替换／删除或缓存收益，不能把普通 Responses 六次成功当作这条路径已验证。

另纠正实验参数的适用范围：代理转换会移除 max_output_tokens、prompt_cache_options、prompt_cache_retention 和嵌套 prompt_cache_breakpoint。因此实验声明的 2048 tokens 是客户端请求值，不是已证实的上游限制；cacheRetention=none 也不能被描述为整个服务端链路确定关闭了缓存。六次实验仍只证明观察到的调用与指令行为，没有采集缓存命中证据。后续必须结合这一实际代理路径验证原生增量和缓存，不直接套用公共 Responses 文档的全部能力。

### 接入顺序与工具／技能差异

2026-10-10 用户确认按“上下文基线与增量机制 → tool → skill”的依赖顺序推进。共同机制负责首次全量、变化增量、无变化不追加，以及恢复／压缩后的基线重建；不要求工具和技能使用同一种内容结构。当前先用实际工具验证机制，技能的具体加载与生命周期规则随后设计，不预建统一能力插件框架。

| 方面 | Tool | Skill（后续） |
| --- | --- | --- |
| 首次向模型公开 | 工具名称、描述、参数 schema 等调用声明 | 技能名称、简介及加载标识；不全量注入正文与资源 |
| 变化同步 | 增删声明、替换变化的定义；执行允许集合同步生效 | 简介目录增删／更新；已经加载的正文是否失效或替换需单独确定，不能把目录更新等同于正文已更新 |
| 使用方式 | 模型发起结构化调用，由执行器校验、执行并返回结果 | 模型按需取得正文与资源；技能可能指导多个工具的组合使用，技能本身不自动增加工具权限 |
| 压缩后重建 | 精确重建当前可用工具声明，不依赖摘要猜测 schema | 重建简介目录；已加载且仍需遵循的指令、资源内容按技能生命周期处理，不因此把全部技能正文注入 |

技能加载可以复用工具循环，但“技能目录同步”“正文／资源加载”和“实际工具执行”各自保留职责。技能仍有确定的后续方向，不是取消，也不因接技能而恢复当前已暂缓的 preset 工作。

### 当前消息字段逐项对齐

下表的领域目标是 src/message.rs；当前 PB 转换在 xiaowei-agent/src/message_codec.rs，types 的 xw-contracts 依赖及 TryFrom 出口已移除。字段与原无损往返不变，不为存储 schema 改写 LLM 契约。

| 领域实体／字段 | 当前 PB 对应 | Pi／旧版对齐与处理 |
| --- | --- | --- |
| `AgentMessage::{User,Assistant,ToolResult,SystemContext}` | `ChatMessage.message` 的 user／assistant／tool_result／system_context | 系统更新由 harness 的独立记录投影，其他三种保留原有对话语义；旧 User 内嵌工具结果改为独立 ToolResult |
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

领域 SystemContext 经 LLM PB 的结构化 system_context 传给 worker，再映射为 Pi `SystemMessage.sections/toolsAdded/toolsRemoved`；映射字段存在不代表当前 provider 已可靠支持全部工具变化，具体拒绝条件见上文。Agent 聊天的顶层 system_prompt 为空，实际指令随有序 messages 传递；RunContext 保存工具执行元数据。custom agent message、deferred handle、diagnostics、raw errorMessage，以及 Codex encrypted reasoning／专有响应项仍不在当前契约内。安全失败说明由 `GenEnded`／`TurnEnded`／`RunEnd` 表达，不能用任意 AppEvent blob 假装已经支持其他能力。

### 文件与 Rust 类型职责

以下为 01a 实际文件。主要上下文字段在下文说明，磁盘字段统一见历史格式；运行时事件、公共 DTO 不加入此存储联合。

| 目标文件 | 类型与边界 |
| --- | --- |
| `crates/xw-agent-types/src/ids.rs` | SessionId／EntryId／InputId／RunId／TurnId／GenId／MessageId／BlockId／ToolId／InteractionId／ClientRequestId 的独立 newtype，UUIDv7 文本编码；Sequence／MetadataRevision 为独立 u64 计数类型 |
| `src/rollout.rs` | JournalEntry／EntryPayload（含无 data 的 SessionHeader）、SessionMeta、输入接纳／消费／取消、RunStarted、TurnStarted／Ended、GenStarted／FirstSseReceived／Ended、RecordedMessage、ToolIntent／Outcome、Compacted、RunEnd、SessionSummary／ContextBudgetSnapshot、DeletionMarker |
| `src/context.rs` | RunContext、ModelDescriptor／ModelCapabilities／InputModality、GenerationParameters、ToolDeclaration、RuntimeLimits、InputSource、InputMode、ContextBoundary、RunCause、ExecutionPolicy；没有运行句柄或完整历史 |
| `src/system_context.rs` | SystemContext／SystemContextDelta／SystemContextUpdate，完整基线与具名指令片段、工具增删的纯状态转换；提交与恢复由 core／rollout 负责 |
| `src/interaction.rs` | InteractionOpened／Resolved／Expired、InteractionRequest／Answer、PermissionTarget；没有 observer／delivery 或接收回执 |
| `src/format.rs` | v2 精简序列化／解析入口、版本探测与 FormatError；区别于 PB codec，不处理文件 I/O；错误 path 只含已知 schema 字段与索引 |
| `src/validation.rs` | 单记录结构校验、记录间引用／状态校验、有效模型上下文与模型能力校验；导出 ValidationError／ValidationCode，不给错误附带消息正文 |
| `src/generation.rs` | GenerationRequest／GenerationEvent／GenerationError，含真实 FirstSseReceived；纯数据，不引入异步依赖 |
| `src/model.rs` | ModelSelection／ModelInfo、模型及辅助引用查询错误、默认预算常量 |
| 现有 `src/message.rs` | 完整领域消息；PB bridge 已移出生产 types，正式转换位于 xiaowei-agent/src/message_codec.rs |

### 随 Run 保存的必要上下文

| 类型 | 全部字段 | 语义／不变量 |
| --- | --- | --- |
| `RunContext` | `model: ModelDescriptor`、`generation: GenerationParameters`、`tools: Vec<ToolDeclaration>`、`limits: RuntimeLimits` | 嵌在 RunStarted 中且该 Run 内不变；Conversation Gen 继承，辅助 Gen 自带必要配置。实际指令另由系统上下文基线／增量持久化，不在每 Run 复制；preset 暂缓；权限从历史重建 |
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
