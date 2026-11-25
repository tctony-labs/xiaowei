# xw-agent

自动加载用户／项目级 AGENTS.md 和 rules，并提供可由自然语言触发的 Command 模板加载工具。资源路径、元信息缓存、逐文件增量、生效与恢复边界见[规则与命令资源](docs/resources.md)。

传输无关的 Agent App Server，使用 `proto-agent-rs` 的 Agent 请求／响应与公共视图。内部复用 `xw-agent-types`，通过本包的统一 `AgentHost` 接收生成、模型信息与辅助模型引用；不依赖 Gateway、napi、ModelSettings 或 Storage。

从包根使用 `AgentService`、`AgentError`、`EventSubscription`、`SubscriptionError` 与 `protocol`。先创建会话，再以必填 `session_id` 调用 `subscribe_session`；第一帧 `SubscriptionReady` 已携带该会话元信息与最新 Run 页，并与观察者登记原子完成；随后顺序消费快照之后的直接业务事件。未知／已删除会话返回 `AgentError::NotFound`。订阅过载明确返回 `Lagged` 并结束，需要重新订阅并用新首帧替换缓存。独立 `read_session` 只用于查询，不能覆盖活跃事件缓存。关闭观察者不关闭服务，宿主通过 `close().await` 释放服务并唤醒观察者。

`AgentService::new` 提供内存模式，`AgentService::open(host, root).await` 打开核心自有的 `sessions.sqlite` 与 rollout 文件层；宿主只传目录和模型 Host，不接存储 Gateway。正常启动／列表仅查 SQLite；打开登记会话时按需校验 JSONL、结算遗留运行、恢复历史与配置，不执行旧模型请求。`with_rollout` 仅保留显式 legacy fixture 的文件模式。所有会话控制方法使用同一公开服务入口。会话支持模型配置、幂等创建、单个活动 Run、完整公共历史和有界事件订阅。`start_run` 原子接纳稳定 input ID，立即返回 Run；重复原请求复用同一 Run，冲突请求不修改状态。后台执行多 Turn 工具循环；完整成功 AssistantMessage 与已提交工具结果进入后续上下文，失败／取消保留用户输入和部分显示。`interrupt_run` 指定准确 Run，终态通过 RunCompleted 确认。异步删除和关闭取消并等待任务；持久模式关闭后可从同一根目录重开；内存模式关闭后历史丢失。

模型历史和原始幂等请求合计受 8 MiB 编码预算限制，Run／输入关联最多 1024 项。展示历史冷开时从 JSONL 建立磁盘索引，按 Run／Item 分页，并支持长字段的分片读取。订阅首帧和每次历史响应最多 1 MiB，实时订阅另有 256 帧／1 MiB 积压预算。分页和恢复规则见 [Agent 控制协议](../../.agent/records/active/2026-09-28-agent-chat/control-api.md#重新打开会话的显示历史)。

公共视图保留当前 Generate 的身份、开始时间、是否收到内容及活跃 Item，随同一有序订阅同步；工具执行期间没有活跃 Generate。响应 Item 关联其 Gen，正常终态明确最后一次无工具 response 的归属，允许最终回复为空。历史从既有 Journal 重建这些关联，不新增存储格式或模型 phase 要求；renderer 不必根据末块或正文位置猜测等待、流光与最终回答。

```sh
cargo test -p xw-agent --locked
cargo clippy --no-deps -p xw-agent --all-targets --locked -- -D warnings
```

持久宿主在依赖就绪后调用 `Arc<AgentService>::start_maintenance()` 启动会话维护，或通过 `maintain_sessions().await` 执行单次检查；`close().await` 会先停止维护再关闭数据库。Gateway handler 和桌面绑定由 xiaowei-agent 集成层承担，不在此包注册 routes。

模型／思考选择通过 `set_session_config` 独立提交，并以 metadata revision 校验冲突。`start_run.config` 只覆盖该 Run，不修改会话默认。运行中切换不会改变已经捕获的配置。模型信息失败保持原引用可发送，警告通过快照／事件同步；实际预算回退为 256_000／32_768，未知能力保持未知。标题任务每次从 Host 查询辅助引用；标题及来源只保存至 SQLite，辅助引用不落 Meta。

`xw-agent-rollout` 负责文件提交和尾部修复，本包负责上下文重建／业务结算。写盘失败终止 Run；下一条 query 在 NeedsCheck writer 上先修复并收尾，成功后开启新 Run，无自动重发。只有 InputAccepted 而未开始 Run 的输入仍保留身份，重试返回冲突，不重新接纳。持久模式列表支持普通／归档过滤和分页；归档先停止结算，取消归档后才能打开。删除先提交 SQLite deleting，再直接清理登记文件和自有 workspace，成功后移除记录；失败保留状态，重开只重试已知删除路径。模型生成的标题提交 SQLite 后尽力追加 `title_generated`；事件只保存 Run ID 和有效轮次，追加失败不影响已保存标题。

系统上下文的核心入口为 `plan_system_context_update(previous, desired)` 和 `sync_system_context(journal, desired, timestamp_ms)`：按具名指令与工具内容计算首次基线或变化增量，无变化不写。后者以 Journal 的已提交记录为准，写入失败不推进状态；NeedsCheck 时先由调用方修复，不自动重试。`rebuild_context` 的 `system_context` 返回指定历史边界的当前状态，None 与已建立的空基线不同。生产 `start_run` 已在生成前提交同步结果，`rebuild_context` 将独立系统记录按历史顺序投影进模型请求；跨 Run 无变化不追加，重开不重复基线。

`build_chat_system_context(tools)` 装配[基础提示词](src/prompts/base.md)和实际可用工具的通用规则。`tool_registry` 在会话创建、加载及 Run 启动时根据 cwd 和当前 `PermissionMode` 装配工具与 `environment.permissions`。切换模式只追加已变化的权限说明及 `RequestPermission` 的声明和规则，通用工具定义保持稳定。未变化的后续 Run／重开不重复记录上下文。

宿主通过 `create_session_with_permission_mode` 提供初始模式，桌面当前传入 `FullAccess`。同一个创建请求 ID 的重试必须匹配原始模型配置、cwd 和初始模式。`set_session_permission_mode` 在两次 Run 之间更新会话的模式，活跃 Run 返回冲突。

当前模式保存在 JSONL 旁的 `<session-id>.permission-mode` 文件。写入临时文件并同步后，原子替换正式文件，随后更新内存。写入失败后重开仍使用上次提交值。没有模式文件的会话以 `Interactive` 恢复。每个 Run 用同一个内存快照生成工具声明与权限提示词，并执行工具。权限提示词和工具变化沿用 `SystemContext` 记录，`Meta` 和 `RunStarted` 维持已发布的 v2 格式。各模式的文件权限见 [runtime](../xw-agent-runtime/README.md)。

有 cwd 的会话同时提供固定 schema 的 `Skill` 工具。每个新 Run 在阻塞池扫描 `<root>/skills/` 和 `<cwd>/.xiaowei/skills/`，固定本 Run 的名称、简介和正文，项目级同名技能优先。用户级目录沿用宿主传入的 Agent 根目录，desktop 默认 `~/.xiaowei/skills/` 并遵循已有 `XIAOWEI_AGENT_HOME` 覆盖；纯内存服务没有用户级根目录。技能目录与正文更新从下一 Run 生效，不需要文件监听。

模型先看到 `skills.catalog` 简介目录，只有实际调用 Skill 才加载正文。成功工具结果提交后更新内存指令，在该次模型回复的全部工具结果闭合后，通过已有 SystemContext 提交 `skill.body.<name>`，随后才开始下一次生成；重复加载不重复提交正文。下一 Run 更新已加载且仍存在的技能正文，删除则撤销其指令；删除后重新出现的技能需要再次加载。重开从已提交上下文及成功工具结果恢复加载状态，不自动调用工具。结果或上下文提交失败停止 Run；仅有未结算意图的 Skill 在恢复时取消，已提交加载可在下一 Run 重建，不自动重新生成。Skill 不改变工具集合、已有授权或沙箱，slash command 主动入口另行实施。

宿主通过 `set_tools(Vec<ToolRegistration>)` 或 `update_tool(id, Arc<dyn AgentTool>)` 更新默认外部工具集；重复注册 ID、模型工具名或规则名校验失败时保留原集合。CreateSession 在幂等检查后捕获声明、规则和执行器的完整快照，尚未首次发送的会话也保持原绑定。默认集合更新只影响当前进程之后创建／加载的 session；重启恢复按当前默认集合重新绑定，再走既有系统上下文增量与 provider 能力校验。外部工具不依赖 cwd，内置文件／进程工具继续要求 cwd。

外部工具从同一 session 绑定分派，core 不依赖 Web crate 或具体搜索源。共享逻辑工具可自行替换内部 provider，因此已有 session 的后续搜索透明使用新对象，暴露及系统记录不变。

`ToolContext.extract_text` 当次查询辅助模型，按模型能力构造独立 RunContext，提交 `GenStarted(ToolExtraction)`、首 SSE、原始完整／部分 Message 和 GenEnded 后才允许提交工具结果。辅助 Gen 使用相同 Run、空 Turn、独立 Gen／Message 身份；不进入聊天 Item、最终回复、对话次数、上下文测量或后续 Assistant 历史。usage 仅按 Gen 记录，工具结果不复制。停止先结算活动辅助 Gen，再取消工具；写入失败沿既有冻结／修复路径停止 Run。恢复先结束辅助 Gen，再按当前已装配工具的 CancelPending 策略补取消；未装配工具保留未知结果保护，不重抓取或重新生成。

`AgentService::open` 在打开存储前，将 root 按进程当前目录转为绝对路径，数据库、rollout 与默认工作目录使用同一根目录，root 无需预先存在。创建持久会话时，默认使用 `<root>/quick-chat/<session-id>/`，可显式指定已有绝对目录。cwd 创建时写入 Header，重开保持稳定；无 cwd 的旧 Header 按固定自有目录回退而不改写。归档保留文件；删除只清理自有目录，外部 cwd 保留。无根目录的内存会话没有 cwd 时只提供文本聊天。

工具循环由本包持有 Journal 的 `run_loop` 编排，runtime 负责单次生成收集、文件原语及 Bash 的进程／沙箱生命周期。每 Run 至多执行 50 次工具调用；完整 TOOL_USE 才执行，意图在副作用前提交，结果提交后才开启下一 Turn／Gen。停止会向 Glob／Grep 传递取消并等待阻塞搜索退出，等待已开始的文件写入实际结算或异步 Bash 回收，余下调用补 skipped，不再生成；删除和关闭等待相同清理。Bash 保留真实退出结果与部分输出，取消显示 Cancelled，超时显示 Failed，普通非零退出仍显示 Completed。Bash 返回 ResultUnknown 时提交带错误原因的未知结果，余下未执行调用补 Skipped，并将当前 Run 结算为 Failed；同一会话可立即或重开后发送新消息，未知结果随历史传给模型，不自动重放旧调用。结果提交失败仍保留未结算意图，沿写盘修复路径处理。公共工具 Item 可由历史重建。

后台 shell 由会话持有并关联创建它的 Run。正常完成的 Run 可以把任务留给后续 Run。停止会等待当前 Run 启动的 shell 回收，归档、删除和关闭会等待整个会话的 shell 回收，再释放会话资源。`BgRun` 已启动但结果无法提交时，立即回收该 shell，并保留已提交意图的未知结果。Journal 保存工具调用和结果，重开只恢复历史，旧任务 ID 失效。工具和输出限额见 [runtime](../xw-agent-runtime/README.md#后台-bash)。

AskUserQuestion／RequestPermission 在同一 Run 中等待用户决定，等待时没有活跃 Generate，也不持有服务锁。公共交互附在原 ToolCall，快照和 InteractionUpdated 保持同一身份；回应按 revision、可信来源与 client request ID 校验，首个持久决定胜出，相同决定的原请求重试幂等。`RequestPermission` 仅在 `Interactive` 提供，批准后立即刷新本 Run 的文件工具和下一次 Bash 调用的授权。批准范围随会话恢复，停止／关闭使未决请求失效，重启不恢复等待或自动执行。

TodoWrite 沿用相同工具循环和 ToolOutcome 提交，完整清单在成功结果元数据中保存。每 Run 从核心完整投影中最后一次成功结果恢复状态，失败／跳过的调用不覆盖清单；合并结果和空清单均可跨 Run／重启恢复，不写独立 todo 文件或 SQLite 表。已提交意图但没有结果的更新在恢复时结算取消，保留之前成功的清单，不重放；意图提交前失败仍沿用既有未闭合调用保护。工具行为见 [runtime](../xw-agent-runtime/README.md)。

交互送达独立于决定：`observe_interactions` 先返回 ready，再按需投递当前待答请求，空闲时每 20 秒 heartbeat；`acknowledge_interaction` 只确认指定 caller／observer／delivery 已接收，不授予权限或恢复工具。观察者及回执有界，关闭观察不解决请求。恢复时只为已知的两个交互工具重建持久回答结果或补取消；外部工具的未知副作用保护保持不变。
