# 历史格式、校验与文件生命周期

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。本文是同一 record 的专题附件，状态与范围由主 record 管理。

当前 JSONL 使用精简格式 v2。开发历史已经按用户确认清空，没有 v1 reader、数据转换或运行时升级分支。文本生产者已接入；工具、Interaction、压缩的历史语义由固定 fixture 验证，实际执行仍属后续工作。消息与 RunContext 见[领域类型](model-types.md)，Host 见[宿主接口](host-interface.md)。

## 编码边界、SessionHeader 与 Meta

磁盘表示由 types 的私有 codec 管理，领域对象保留运行、校验和重放需要的完整字段。序号按文件顺序重建，UUIDv7 只承担身份，不承担排序。payload 使用 `type`／`data`，所有字段及 variant 使用明确的 snake_case 名称。

| 位置 | 实际保存字段 | 重建规则 |
| --- | --- | --- |
| 第一条 SessionHeader 的外层 | `schema_version: 2`、`session_id`、`entry_id`、`timestamp_ms`、`payload` | 时间提供会话创建时间；Header 只写一次 |
| Header payload | `{"type":"session_header"}` | 无 data，不包含模型配置 |
| 后续记录外层 | `entry_id`、`timestamp_ms`、`payload` | 版本及会话身份从首条继承；不重复保存 `sequence` |
| Meta payload | `model_ref`、可选 `reasoning`／`provider_name`／`model_name` | 第二条保存初始配置，之后每次写全量小配置；省略 reasoning 表示模型默认，不包含创建时间 |

Meta 不保存标题、标题来源、归档、创建请求 ID／来源、原始创建配置、workspace 路径、metadata revision、系统指令或辅助模型引用。标题、自动标题开关和管理状态以 SQLite 为准。`execution_policy` 当前固定 Interactive，运行尚未消费；工具实现需要时再设计持久记录。

CreateSession 先查询 Host 模型信息，成功时初始 Meta 带独立名称；查询失败仍按原选择创建，省略未知名称并通过公共快照提示。Header 和初始 Meta 都提交成功后才登记 SQLite，初始模型查询后不再重复启动创建刷新。模型／思考选择修改立即提交新 Meta；普通发送不重复保存会话配置。provider_name／model_name 分别保存（如 tctony 与 sol），最终展示时才组合为 `tctony/sol`。后续查询成功补充名称时可追加 Meta，名称变化不改写历史 Run，查询失败提示与连接状态不落盘。

后续可选工作目录的设计归属（用户确认）：`cwd` 放入 SessionHeader，创建时确定，后续默认不更改，不放 Meta；工具接入时带入 RunContext。本次仅记录设计决定，未新增目录字段或自动切换行为。

创建请求 ID 与原始参数只在当前服务实例内存中去重，重启后不重建；重开使用 session_id。InputAccepted 的业务身份仍持久化：相同 input ID／相同请求返回原 Run，相同 ID／不同请求冲突；只接纳尚未开始 Run 的输入重试明确冲突，不自动执行。

optional 字段通常省略，必要时用显式 null 表达未知，具体规则见下表。未知字段／variant、重复键、错误对象形状及不合法引用均拒绝；没有兼容丢弃旧字段的路径。原始 provider JSON 作为字符串保存，不重排、不经 JS number 规范化。

## Input、Run、Turn、Gen 与消息

以下是**磁盘字段**，省略项由 codec 从已验证的前缀恢复。

| payload | 保存内容 | 恢复／生命周期约束 |
| --- | --- | --- |
| `input_accepted` | `input_id`、`source`、`mode`、可选 `expected_run_id`／`expected_head`／`selection`、`message` | 正文只存一次；message 保存 message_id、block_ids 和内容，省略重复 input ID、空运行归属、固定 User 类型与 Complete。内部消息时间等于外层时省略 |
| `input_consumed` | `input_ids`、`turn_id`、必要时 `boundary` | 从 Turn 恢复 Run；boundary 与 TurnStarted 相同则省略。接纳、消费和开始执行仍是独立事实，半组提交可识别 |
| `input_cancelled` | `input_id`、`reason` | 只取消未消费输入；Recovery／SessionClosing |
| `run_started` | `run_id`、`cause`、`base_context`、`context: RunContext` | 保存本 Run 不变的必要执行配置，不另存 ContextDefined／ContextId，不建立跨 Run 配置去重引擎 |
| `turn_started` | `turn_id`、`run_id`、`boundary` | ordinal 从同 Run 的 TurnStarted 数量重建，从 1 连续递增 |
| `gen_started` | `gen_id`、`purpose`、`boundary`、必要时 `turn_id`／`run_id`／`context`／`started_at_ms` | Conversation 从 Turn 取得 Run、从 Run 取得配置；ToolExtraction 从 Tool 取得 Run；其他辅助 Gen 保存必要归属及自身配置。attempt 从该 Turn 的 Conversation Gen 次数重建；辅助调用为 1。开始时间等于外层则省略 |
| `gen_first_sse_received` | `gen_id`、必要时 `received_at_ms` | 时间等于外层则省略；每 Gen 至多一次，必须先于 GenEnded |
| `message` | `gen_id`、`message_id`、`block_ids`、`completeness`、`message` | 仅保存 Assistant；Run／Turn 从 Gen 恢复，省略空 input ID 和固定角色。实际 api/provider/model、签名、response ID、响应模型、推理档位、raw stop reason、end_turn、usage 等仍完整保留 |
| `gen_ended` | `gen_id`、`status`、可选抢占原因、实际结束时间、停止原因、用量、上下文测量、单调耗时、思考耗时、安全错误 | assistant_message_id 从 Message 恢复。与 Message 完全相同的已知 usage／stop reason 省略；独立观测保留。正常结束时间等于外层则省略；恢复未知结束时间必须显式 null |
| `turn_ended` | `turn_id`、`status`、可选抢占原因、单调耗时、安全错误／`error_ref` | final_gen_id 从最后一个所属 Conversation Gen 重建；不能指向工具提取 Gen |
| `run_end` | `run_id`、`status`、可选单调耗时、安全错误／`error_ref` | 输出标志、工具次数及最后一个所属 Conversation Gen 的 context_tokens 重建，不再重复保存 |

`RunContext` 保存 model（引用、独立展示名称、可选能力、预算及来源）、generation（有效生成参数）、tools（声明）和 limits。model.capabilities 的窗口／输出上限与 model.budget 相同，仅在 budget 保存一份，解码补回领域能力对象。系统指令每次使用 host 注入值，不保存到 RunContext；工具实例、连接、取消句柄、缓存和完整会话消息仅在内存组装。

InputMode 为 FollowUp／Steering／Preempt（另有普通 Send）。FollowUp 按接纳顺序由下一 Run 消费；Steering 在工具之间的安全检查点生效，尚未启动的批次工具结算 skipped 后进入同 Run 后续 Turn；Preempt 先打断当前 Gen／工具，完成抢占结算后进入同 Run 后续 Turn。Steering／Preempt 必须指向活动 Run。当前公共 RPC／运行调度只接纳 Send，其余模式保留类型与历史校验，没有提前提供空调度或 UI。

RunCause 为 Send、非空有序 FollowUp 批次或 Continue（关联旧 Run、独立 client_request_id 与认证后的 source）。Continue 必须先结算旧 Run，不复用其 ID。InputSource 使用 Desktop／Cli／Remote／Internal 与稳定 principal_id；不保存 transport token，Remote 类型不等于手机功能已交付。

Session → Run → Turn 表示执行归属，Input 独立接纳；Item 是公共展示投影。我们的 Run 对应 Codex App Server Turn，一个本项目 Turn 包括生成及其工具结果。显式重试可在同 Turn 产生多个 Gen，前次须失败且未执行工具；本期没有自动重试功能。

正常顺序为 InputAccepted → RunStarted → TurnStarted → InputConsumed → GenStarted → 可选首 SSE → Message → GenEnded → ToolIntent／Outcome（如有）→ TurnEnded → 下一 Turn 或 RunEnd。模型返回工具调用只结束 Gen；正常 Turn 结束必须等工具结算。同会话 Run、同 Run Turn 不重叠，各终态唯一。

只有已消费输入、成功 Conversation Gen 的完整消息及工具结果进入有效模型上下文；部分／失败回复保留展示。重试不重复消费用户输入。Run 结束前须结算已开始的 Gen／Turn；写盘失败及崩溃允许保留合法未完成前缀。

### 时间、统计与错误

Gen 开始／正常结束由 runtime 采集，首 SSE 时间来自执行宿主 worker 收到首个**完整 SSE data event** 的观测。它不是 headers、首个网络字节、Pi start、Gateway frame 或首个正文 token。跨 chunk 和 CRLF 拆分只记一次，heartbeat 无 data 不计；非 SSE／未观测保持未知。结束事实未知时，恢复提交时间不能冒充实际结束时间。

内部观测时间仅在与外层相等时省略；真实差异保留。墙钟回拨不改变文件顺序，duration_ms 使用单调时钟，不能由墙钟差猜测。context_tokens 是单独测量，不能自动等同 usage.input 或 usage.total；辅助模型测量不覆盖聊天上下文测量。

Gen／Turn／Run 的状态及耗时保留各自含义。同一安全错误从子终态向父终态传播时，父记录可使用 `error_ref` 引用已提交的因果错误记录；不同错误保留各自正文。抢占终态／InteractionExpired 显式保存 preempting_input_id，不从后续输入推断。

## 工具、Interaction 与压缩

| payload | 保存内容 | 派生内容／约束 |
| --- | --- | --- |
| `tool_intent` | `tool_id`、`block_id`、可选 `generation_duration_ms` | 通过已保存 ToolCall block 恢复 Message／Gen／Turn／Run、provider call ID、名称及原始参数；副作用前必须提交 |
| `tool_outcome` | `tool_id`、`status`、`result`、可选 `error`／`metadata_json`／`duration_ms`／`elapsed_ms`／`queue_duration_ms`／`settled_by_run_id` | 从 intent 恢复 key、角色和工具关联，is_error 从状态恢复；result 保存 message_id／block_ids、正文及真实执行元信息 |
| `interaction_opened` | `interaction_id`、`tool_id`、`request` | 从 Tool 恢复 Run，初始 revision=1 |
| `interaction_resolved` | `interaction_id`、`client_request_id`、`source`、`answer` | 终态 revision=2；与 Expired 互斥，首个有效决定提交后才生效 |
| `interaction_expired` | `interaction_id`、`reason`、可选 `preempting_input_id` | 终态 revision=2；迟到决定不能复活 |
| `compacted` | `gen_id`、`replaced_through_entry_id`、`replacement_history`、`trigger`、可选 `tokens_before`／`estimated_tokens_before` | 从 Gen 取得归属／边界及预算，从 GenEnded 取得单调耗时；从有效历史取得前一检查点和保留后缀，从 replacement_history 派生 summary |

工具调用须来自成功完整 Conversation Gen，provider call ID 仅在该 Gen 内唯一；内部 ToolId 独立。结果与执行状态在同一 entry 提交，参数非法／未知工具也形成明确结果。duration、elapsed、queue duration 分别表示执行、整体经过和排队，不能互相替代；执行 metadata_json 与模型 details_json 分开保留。

ToolIntent 无 Outcome 表示副作用可能发生，不能自动重试。后续 Continue 可结算旧 ResultUnknown，尚未建立 intent 的旧调用可明确 Skipped；settled_by_run_id 关联当前 Continue Run，不能假装旧工具成功执行。旧配对闭合后才能开始新的 Turn／Gen。

InteractionRequest 为 Question、Permission 或 ToolExecution；回答类型匹配、索引有界且不重复，单选至多一个，并允许自由文本。PermissionTarget 由服务端解析，客户端不能扩大授权路径。ToolExecution 用于 Continue 后模型重新提出等价副作用时确认，不重新执行旧 intent。送达 ACK、客户端连接和 observer 状态只放内存。

Compaction 必须来自已成功结束的 Compaction Gen，替换范围属于其调用时有效历史，保留工具闭合的后缀。检查点成功提交后才切换有效上下文，原始历史不覆盖；失败不能静默丢弃消息。重放可沿检查点链恢复，rewind／fork 的公共 API／分支 provenance 仍属后续范围。

## 公开 codec 与校验

所有入口由 lib.rs 显式导出，内部模块私有。调用方使用 codec，不能直接用领域 serde 表示作为磁盘格式。

| 入口 | 职责 |
| --- | --- |
| `encode_entry(entry, preceding_history)`／`decode_entry(line, preceding_history)` | 一条 JSON，不含换行／文件 I/O；结合已提交前缀派生字段，并检查完整候选历史 |
| `encode_history(entries)`／`decode_history(text)` | 按文件顺序编解码完整历史；写出带换行的记录 |
| `validate_entry`／`validate_history` | 局部结构、数字及 JSON；跨记录身份、引用、输入消费和状态转移。合法未完成前缀可通过 |
| `validate_model_context(messages, capabilities)` | 最终 worker 消费条件、消息角色、工具配对、图片能力与数值口径 |
| `ContextBudgetSnapshot::from_entries` | 重建聊天测量／stale 与检查点，不把辅助 Gen 当聊天测量 |

FormatError 区分 UnsupportedVersion 与 InvalidStructure，ValidationError 返回稳定 code／entry_id／message_index／path；只包含已知字段及数字索引，不透出正文、动态未知 key 或原始 provider 错误。重复 JSON key 递归拒绝，i64／u64 与有限浮点保真，嵌套原始 JSON 字符串保留字面值。

首条先探测版本，再读取对应结构。未知版本、未知字段、完整但语义非法的尾部均保留报错，不能当作截断尾部清除。当前只有 v2 reader／writer；以后改变已发布必填结构或语义须明确版本演进，不在本轮实现迁移引擎。

## JSONL 提交与恢复

1. main 解析绝对路径 `XIAOWEI_AGENT_HOME`，默认 `~/.xiaowei`，直接传给 Agent.open，不添加 agent 子目录。文件位于 `<root>/sessions/YYYY/MM/<session-id>.jsonl`，年月来自创建时间 UTC，不从 UUID 推测；workspace 位于 `<root>/workspaces/<session-id>/`。模型设置在同根的 models.json；其他业务数据保持原目录。
2. xw-agent-rollout 取得跨进程独占写锁后读取／修复。锁覆盖可写 Journal 生命周期，不抢占其他宿主。完整行、换行、flush／sync_data 成功后才推进确认边界并发布持久状态，多行不是原子事务。live cache 使用同一 compact codec 重建，和文件重开结果一致。
3. 冷打开或 NeedsCheck 后的下一次使用才重新检查文件，正常 query 不重扫。末端截断／未提交换行的合法记录保存 tail 诊断后截断，不提升为提交；未知版本／字段、完整非法记录和中间损坏保留报错，不跳过。
4. 必需记录写盘失败立即使整个 Run 失败并取消生成，提示用户排除磁盘空间／权限问题。没有补写队列、恢复按钮或自动重发；下一条 query 必要时清理失败尾部、结算旧 Run，成功才接纳新输入，仍不可写则报错。
5. 文件层只管理读取／修复／提交，业务恢复归 xw-agent。核心识别未完成 Input／Run／Turn／Gen／工具／Interaction，追加基本中断终态；当前实例已知写盘失败可补 Failed，冷打开未知原因补 Interrupted。实际 Gen 结束时间未知保持 null，不重执行历史模型或工具。
6. 有效上下文按稳定 entry 边界、适用检查点和后缀重建；公共投影恢复 Run／Item 和原 input 请求身份。完整 Assistant 来源、签名和统计来自历史响应，不能从当前模型补猜。

生产 AgentService::open 初始化与列表只读 SQLite，打开登记会话才读取对应 JSONL；未登记文件不自动导入，损坏会话单独报错。显式非 indexed 测试入口和独立 deletion marker API 不属于生产持久会话路径，不能替代 SQLite 标题／归档管理。

## 会话索引、归档与删除

xw-agent 直接管理 `<root>/sessions.sqlite`，xiaowei-agent 只传目录及 Host；CLI 可复用 AgentService::open。没有存储 RPC、Storage／Gateway 索引 DAO 或额外 SessionIndex trait，文件层不依赖 SQLite。

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `session` | `session_id`、`title`、`auto_title_enabled`、`created_at_ms`、`updated_at_ms`、`archived`、`archive_revision`、`deleting` | 8 列，会话目录、标题与管理状态；archive revision 持久化，deleting 支持定向清理 |
| `meta` | `key TEXT PRIMARY KEY NOT NULL`、`value TEXT NOT NULL` | KV，保存 retention.archive_after_days／retention.delete_after_days；新库默认 3／0 |

metadata_revision 只存在当前服务实例的 Session 内存，冷恢复从 1 开始；不写 SQLite 或 JSONL，不维护独立 index_revision。当前服务 gate 串行元信息持久操作，公共快照／列表提供当前内存版本；未加载会话列表为 1。重连到重启服务后客户端必须获取新快照并丢弃旧待提交请求／版本，不能跨实例比较。archive_revision 继续约束持久归档状态。

标题与 auto_title_enabled 只存 SQLite，不参与模型历史。首 query 前 15 个 Unicode 字符作初始标题（空白归一），无 first_input_preview。手动改名关闭自动标题，主动重新生成成功重新启用。普通发送、手动改名／主动生成、取消归档推进 updated_at_ms；Run 后自动标题保留原时间。Quick Chat 启动选择最后更新的未归档会话，不单独保存选中 ID。

列表按 updated_at_ms DESC／session_id DESC 分页，默认 50、最大 100，query 匹配标题；continuation 是列表位置，不是事件 cursor。标题、自动生成开关及归档状态无法仅从 JSONL 恢复，SQLite 不能随意删除重建。

归档先冻结新操作、停止并等待当前 Run／标题结算，再提交 SQL 状态；保留已有回复。归档后禁止打开／订阅／发送／修改配置及标题，必须先取消归档。已建流按序收到结算与归档事件后结束。Quick Chat 切换只列未归档会话，归档页在设置中提供单条删除／恢复，恢复只 toast，不打开窗口或选中会话。

删除使用批量 DeleteSession 的明确目标，归档目标同时校验预期 archive revision，逐项结果见[控制协议](control-api.md)。停止并等待执行后提交 deleting 状态，直接删除对应 journal／自有 workspace，成功再移除目录记录；失败保留 SQL 状态，下次启动仅定向清理这些记录。不扫描全部 JSONL，不长期保留删除目录，不删除授权外部路径，不跟随 symlink。

自动归档／清理任务由 xw-agent 持有，启动、每小时及设置变更后检查；SetPolicy 先提交再替换任务，关闭时等待退出。正在生成或任意 UI 标记 viewing 的会话不自动归档，单纯订阅不阻止；取消归档刷新活跃时间。策略与定时器均不由设置页面重复保存或运行。
