# 基于 Pi 的 LLM provider

## Why

Quick Chat 后续需要模型调用、流式事件、工具、取消和推理内容。用户决定复用成熟的 Pi 模型调用库，并希望通过现有 Gateway 让 TypeScript 的模型生态与 Rust 的 agent／会话能力协作，而不是迁入旧版 `xw-llm` 的自有 HTTP、SSE 和 WebSocket 实现。

## What

建立可供 Agent／Quick Chat 使用的 Pi provider 边界。最终需能按当前设置选择模型和凭据，处理请求、流式文本／推理／工具调用、使用量、结束／错误与取消，并经 Gateway 供 Rust agent 调用。已交付 Gateway worker 通信、Pi 补丁、完整生成与模型目录、持久模型设置及 Responses WebSocket。LLM service 在 Node worker 内运行；Agent 产品调用另由 Agent Chat 事项维护。

本事项不接入 Quick Chat 产品 UI，不改变会话数据，也不以直接模型调用代替旧 agent 的工具与恢复语义。UI 入口预览另见 [Quick Chat UI 事项](../active/2026-09-24-quick-chat-ui-interaction.md)。

## How

采用 Pi 模型调用库，由 Node worker 执行生成，经既有 Gateway 连接 Rust caller；Rust 继续持有 Agent 会话、工具执行及恢复，避免把 provider 扩展成另一套 Agent。应用使用 Pi 公共 API 窄入口，自有模型配置和领域契约不继承 SDK 类型。

旧版源码参考基线为 `xiaowei-next` 的 `6be131098d0b907b988f7f53460f450c89b9034c`，DSH 参考基线为 `46a7f68b0922371ce7144b668b90e377d8e799f4`。DSH 的 Cordis、认证与会话系统没有迁入；其工具参数增量解析补丁作为来源依据，重基至本次采用的 Pi 版本。`@mariozechner/pi-ai` 与 `@earendil-works/pi-ai` 是同项目旧／新发布名，本次选择后者。

保留有序内容块、工具关联、推理签名、来源及用量，避免以合并文本或当前模型伪造旧历史。SDK 自动重试关闭，以免和 Agent 重试叠加；没有承诺完整旧历史导入或所有旧版断线恢复语义。

模型配置采用独立 JSON 文件与 main owner，不放入 Storage 或系统安全存储；保存与 worker 应用分别表达，保留已保存但未应用的故障语义。通用 Responses 保留既有协议、API Key 和 URL，通过补丁复用 WebSocket 传输与连接池，不改成 Codex 登录调用，也不在发送后盲目重试。

当前模块、接口、配置持久化、生成事件、资源限制和 WebSocket 约定已沉淀到 [LLM provider](../../../docs/llm-provider.md)，后续持续更新该文档。补丁来源与升级步骤维护在 [patches README](../../../patches/README.md)，手动验收入口维护在 [脚本说明](../../../desktop/scripts/README.md)。

## Alternatives considered

- 迁入旧 `crates/xw-llm/` 的协议实现：用户已明确选择复用 Pi，不再推进此方案。
- 在 renderer 中直接调用模型：无法保住当前 main／Gateway 的调用与凭据边界。

## Outcome

2026-10-07 按用户明确要求以 completed 归档：本次 provider、模型配置和 Responses WebSocket 的交付范围已完成，后续不再基于该 record 进行重大改动。当前说明按源码整理到 `docs/llm-provider.md`，其中配置入口修正为 `config.ts`；原事项无遗留实施 Plan，当前说明的查阅入口已转向长期文档。此次仅整理文档，以下历史验收与未验证边界继续保留，未重新运行模型或修改用户配置。

Responses WebSocket 的源码与真实验证参考代理部署提交 `81e9a1c67bd74169b23772ee848b215e4e8ee1db`。独立客户端验证同连接生成及 previous_response_id 续接可用；产品真实桌面对话也观测到跨轮同连接、增量输入及无 SSE 回退。它证明客户端到代理的复用，不能推断代理到上游的传输。连接已断后不能把 response ID 当作跨连接持久会话。实验性的临时适配副本／打点已移除，不是产品入口。

已交付 Node worker 中的 Pi provider、完整生成／工具声明与结果回传契约、取消及安全错误、远端目录、整批模型更新和模型设置持久化。设置产品已通过用户真实配置及调用验收；默认 models.json 位于 Agent 根目录，XIAOWEI_AGENT_HOME／单文件覆盖规则见[长期文档](../../../docs/llm-provider.md#文件格式与路径)。当前 Pi 固定为 0.87.1，工具参数解析及通用 Responses WebSocket 补丁的来源和维护方式见 patches/README.md。

模型上限未填写或清空时，配置文件与 Settings 快照保留未设置语义，表单显示默认值 placeholder，运行时分别补齐为 256,000／32,768；显式值保持优先。该行为已通过配置往返、有效上限校验、表单与实际 worker 默认输出预算回归，just check 和 desktop build 验证。

真实 worker／Gateway 以用户指定配置验证 DeepSeek Completions／Anthropic Messages、代理 Responses 的文本、thinking、图片、工具往返及取消；通用 Responses WebSocket 的工具往返、thinking、连接复用及取消也已验证。上游未提供的价格／能力不视为实测；曾有一次并发 cancel-thinking 失败，单独重测通过，未取得原因，不宣称已定位。

相关 Pi 补丁回归、真实本地 SSE／WebSocket fixture、worker 配置隔离与关闭、Rust typed caller／正式 napi、契约 codec／生成一致性、desktop 回归／构建、frozen install 和 just check 已通过。应用包加载／签名不能由 Node 测试替代；并非全部十种 API、认证方式及补丁路径都有本项目真实运行回归。

Agent 接入时增加独立 provider_name、Llm.GetModelInfo、ModelSettings.GetAuxiliaryModelRef 和真实首 SSE 观测，缺省预算统一为 256_000／32_768。接口 owner、适配边界及专项验证统一见[Agent Host](../active/2026-09-28-agent-chat/host-interface.md)和[交付证据](../active/2026-09-28-agent-chat/implementation-results.md)，不在此重复 Agent 执行计划。

本事项已交付的模型能力继续生效，对应实施计划已删除。OAuth／特殊云凭据、本地模型、图片生成、deferred、文件监听及 Agent 工具执行不属于已交付能力；模型兼容参数编辑遇到具体接口需求再实施。main／剪贴板的历史迁移流水不再混入本 record，当前模块约定见[main README](../../../desktop/src/main/README.md)。
