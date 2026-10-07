# 运行、工具、扩展能力与 Chat UI

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。本文是同一 record 的专题附件，状态与范围由主 record 管理。

本文的工具及扩展语义仍待实施；基础文本 JSONL、Host 和 composer 已接入；当前文本执行见下文。持久配置与 Run 快照按[宿主接口复核](host-interface.md)的已确认调整实施；不追踪 worker 内同引用配置的版本。

## 当前文本执行

Quick Chat 已经 Agent typed client → xiaowei-agent → xw-agent → runtime → 注入的 Llm.Generate adapter 执行。每个 Run 一个 Turn／Gen，不执行工具或自动重试。STOP／LENGTH 的完整有效 AssistantMessage 才进入后续模型历史；EOF、模型失败、非法／不支持输出为 Failed，取消为 Interrupted。失败／取消的用户输入保留，部分回复只用于显示。

Gen 开始／结束和单调耗时在所有退出路径采集；支持 fetch 观察的 worker 路径提供真实首个 SSE data event 时间，其他路径保持未知。聊天 Gen 生命周期与最终完整／部分消息写 JSONL。详情见[Host 观测](host-interface.md#生成流与观测)。

renderer 保留草稿／显示缓存，Rust 持有权威历史与运行。隐藏／收起／观察 cleanup 不停止 Run；新对话先请求停止并等 RunCompleted，然后进入空对话并保留旧会话；普通切换不停止旧 Run；删除仅清理所选会话。实例关闭取消并等待执行，随后释放 endpoint，再关闭 LLM；生产 Agent.open 关闭／重开恢复已提交历史。停止请求失败会显示未确认提示。

UI 沿用现有 textarea、纯文本正文、可折叠思考内容和空态；未生成标题时首条输入作为显示标题。Markdown 解析、代码块渲染及工具卡片尚未实现；标题能力和 composer 模型／思考控件已接入，Host hint／保存行为见[宿主接口](host-interface.md)。

标题栏复用现有完整菜单，复制 Session ID、确认删除和手动更新标题接真实调用，选择会话已接入 SQLite 会话列表和目标观察；重命名已接真实 SetSessionTitle，归档已接真实 SetSessionArchived。菜单状态由 renderer 维护，不伪造 Agent 会话变更；没有消息时隐藏更多操作，已有空 session 或未发送草稿不改变此规则，新建与会话切换入口保留。具体行为和验证边界见 [Quick Chat 入口说明](../../../../desktop/docs/quick-chat.md#产品入口与窗口交互)。实际窗口复验的证据与限制集中见[交付证据](implementation-results.md#验收限制与后续工作)。

ListSessions 从 SQLite 返回摘要（ID、标题／自动生成开关、当前状态、创建／更新时间、metadata revision、archived／archive revision），不传正文或输入预览；按更新时间／ID 倒序分页，普通／已归档列表独立过滤。归档行只能取消归档或删除，不能打开；活动会话归档先结算，再更新 UI 并回到空白草稿。菜单打开时刷新，不承诺全局列表变化流。切换用 ReadSession 检查目标，再建立 SubscribeSession，仅首帧快照替换历史；旧流按本地代次失效。发送与切换互斥，待接纳调用先结算；未确认 input／错误、草稿按会话保存在 renderer 内存，切回仍禁止重复发送。滚动位置也按会话隔离。新建保留旧会话，首次发送创建新 session；已经空白且无在途任务时，新建不改变草稿、空 session、观察或反馈，不输出操作日志；显式删除仍停止／结算后调用 DeleteSession。与旧 quickChatStore 对齐会话保留与目标观察；新建仍沿用当前 MVP 的先停止语义，不导入旧持久数据，启动默认恢复最后更新的未归档会话，unread 后续实施。

启动时 Quick Chat 客户端首次初始化查询未归档列表，默认选择 updated_at_ms／session_id 倒序的第一条，用 SubscribeSession 的原子首帧恢复历史和模型／思考选择；列表为空保持空白，不创建会话。仅每个 renderer 客户端初始化一次，之后收起、切换模式或组件重挂载保留用户当前选择，包括主动新建的空白对话。初始化期间禁用发送，失败显示错误，不自动发消息或补建会话。不额外持久化选中会话 ID。

手动改名和用户主动重新生成标题成功提交会推进 updated_at_ms；每轮结束后的自动标题生成保持原时间，同名手动标题的幂等 no-op 和失败也不推进。SessionTitleUpdated 携带实际提交时间，UI 更新摘要排序；Run 迟到结算不得使更新时间倒退。恢复归档继续更新时间，未归档列表可在下一次应用启动选中该会话。

## 设置归档管理

设置的“对话归档”已接入真实 Agent API，采用旧版 SettingCard 内搜索／列表、悬浮恢复／删除操作和 Modal 永久删除确认。Quick Chat 切换菜单只保留未归档会话的选择入口，不展示行删除按钮；当前会话归档与删除保留在“更多操作”。设置页持有独立列表、query、分页和请求代次，不复用当前聊天缓存；显示真实标题与更新时间，不填造 workspace；自动归档／清理选择器沿用旧版样式。

数据操作统一在 agent.proto：ListSessions(archived=true, query) 查询，SetSessionArchived(false) 恢复，DeleteSession 批量删除。xiaowei-agent 沿用现有 Agent handler，调用 xw-agent 的 SQLite／会话能力；未新增 Settings 会话管理协议或存储 Gateway adapter。恢复只取消归档，成功后移除行并在当前设置页 toast“已恢复对话”，不打开窗口或选中聊天；失败提示并刷新真实列表。

归档页移除“删除全部”入口，保留单条删除；确认捕获目标 ID、metadata revision 和 archive revision，提交一项目标。核心仍保留批量 DeleteSession，便于其他调用方复用。删除结算后保留 query，重置 continuation 并重新拉第一页。

自动策略通过 Agent.GetSessionRetentionPolicy／SetSessionRetentionPolicy 读写，保存在 Agent 根目录 sessions.sqlite 的通用 meta(key, value) 表，使用 retention.archive_after_days／retention.delete_after_days 两个键并原子更新；开发期收敛为最终初始化结构，不保留中间表或运行时迁移分支，不依赖 Storage／Settings Gateway。默认 3 天归档、自动清理关闭；归档选项 1／3／7／15 天，清理选项关闭／30／90／180／365 天。设置保存失败保留原选择并 toast；重新进入／焦点刷新重新读取。保存成功后重启当前 maintenance 任务：取消旧任务，新任务等待旧检查收尾后立即检查一次，随后每小时检查；RPC 返回表示设置已保存并已安排重启，不等待归档／删除完成。保存失败不重启，不直接按当前 UI 列表删除；候选仍由 core 查询 SQLite 判定。

定时任务由 xw-agent 的 retention.rs 持有，xiaowei-agent 在 Gateway 激活后调用 start_maintenance；启动立即检查，之后每小时检查一次，关闭时等待本次检查结束再关数据库。CLI 宿主可复用同一入口或单次 maintain_sessions。每次只查询 SQLite 中已登记的候选，不扫描 JSONL；按 updated_at_ms 的包含边界判断，先归档再清理已归档会话。清理基于最后活跃时间而非归档时间；恢复刷新 updated_at_ms，避免立即再次归档。每项失败记录日志后继续其他项，下次检查再次判断。

可见查看保护独立于 SubscribeSession：UI 在对话页展开且 document.visibilityState 为 visible 时持有 TrackSessionViewing 流；首帧确认保护，隐藏／最小化／切换／离开对话页／卸载取消流并释放保护。多个查看者中任一仍存活即保护；断连由既有 Gateway 流清理释放，不上传窗口 ID，不持久化在线状态。自动归档在与控制请求相同的串行边界复核查看者、活跃时间与版本，并在 SQL 提交时再次比较时间；正在运行、标题生成或索引未提交时跳过。手动归档仍停止并结算当前运行，不受查看保护约束。相对旧版，本实现额外跳过长时间执行任务，防止后台维护打断 Run；归档状态仍只存 SQLite，不追加旧版 Notice／Meta.archived。

批量已删除项不回滚；会话不存在、已恢复或版本变化时跳过并继续；文件清理／SQLite 等实际错误使批次停止，后续项不执行。RPC 返回逐项 Deleted／Skipped／Failed／NotExecuted 及安全说明，UI 显示结果并刷新，用户处理问题后可再次删除。归档页的删除必须仍归档且 archive revision 相符，核心在 SQL 标 deleting 的事务内再次校验，避免跨客户端恢复后误删。

设置页进入、窗口重新获得焦点和操作结算时刷新；Quick Chat 每次打开切换菜单重新查询普通列表。不新增全会话事件流。迟到的旧 query 响应不能替换新列表，页面卸载后不更新状态，操作期间禁用重复提交。自动验证和正式 Gateway／NAPI 链路已通过；实际窗口复验限制见[交付证据](implementation-results.md#验收限制与后续工作)。

## 标题维护边界

标题由 xw-agent/title.rs 维护，只保存于核心 SQLite 后投影至 AgentSession，不追加 JSONL Meta 或进入聊天历史。旧版来源为 xiaowei/studio/src/biz/chat/{title,commands,storage}.rs。运行结束且有助手输出、auto_title_enabled=true 时，在 RunCompleted 后启动后台标题任务，不限于 Completed；没有配置小文本模型时跳过，标题失败不改变聊天终态。采样最近最多 3 轮，每轮用户／助手正文分别截断至 600 字符，排除思考正文；清洗引号、首尾句号和 Markdown 加粗标记，标题最多 50 字符。沿用旧中文提示词、temperature=0.8、max_tokens=64、reasoning=off 与 20 秒超时。

标题任务通过统一 AgentHost.get_auxiliary_model_ref 查询当次辅助引用；桌面 adapter 调用 ModelSettings.GetAuxiliaryModelRef。引用不保存在 Meta，旧 CreateSession／StartRun／RegenerateTitle 的 title_model_ref 字段已忽略。缺配置或查询失败保留旧标题，不回退聊天模型。所有生成复用 Host.generate，runtime.complete_text 仅接受完整成功终态；EOF、失败、取消和空标题不提交。

自动生成完成、手动“更新标题”成功及直接设置标题均提交 SessionTitleUpdated（标题、auto_title_enabled、兼容的空辅助模型字段及 metadata_revision）给该会话所有观察者；快照与会话摘要也包含最新标题及自动生成开关。RegenerateTitle 按当前已确认协议等待最终结果，使用有限超时，不另建标题 Run／Turn。菜单显示手动生成中的状态并防止重复点击；模型缺失／失败显示原有错误提示和设置入口，生成中的聊天不可手动更新。任务在同一服务锁内登记，提交时检查最新任务身份、metadata revision 和会话删除／关闭状态；新输入或新标题任务取消旧任务，删除／退出取消并等待所有任务。旧结果不能修改新会话。

Quick Chat 的“更多 → 重命名”调用 SetSessionTitle。服务端去除首尾空白后，要求标题为 1～50 个 Unicode 字符且不含控制字符；超长拒绝，不截断。提交后 auto_title_enabled=false，取消在途标题任务并禁止后续自动生成；同名确认也会关闭自动生成。开关已关闭且没有在途标题任务时，同名请求不重复提交。手动改名可在聊天生成中执行，不调用模型、不创建 Run，也不停止聊天。客户端仅消费事件更新标题，RPC 响应不覆盖较新的缓存；服务锁内最后接纳的改名生效。切换会话关闭未完成编辑，失败保留旧标题并显示错误。RegenerateTitle 成功设置 auto_title_enabled=true，恢复自动标题；失败保留原开关。该策略对齐旧版 commands.rs 的 rename／regenerate 行为。

### 持久化与剩余边界

标题及自动生成开关先提交 SQLite，再更新内存并发布事件；失败保留旧标题并报错，不改变聊天 Run。新会话默认开启自动标题；首条 query 的前 15 个 Unicode 字符先保存为初始标题，不单独保存预览或标题来源。辅助标题 Gen 有独立 ID 与运行日志，生命周期／用量暂未写 JSONL；辅助 Gen 的持久记录仍在 02l，不把它计作聊天 Run／Turn。

## 完整运行与工具循环（待实施）

Run 开始时捕获已提交会话配置中的模型引用、思考强度和独立的提供商／模型展示名称，以及 Agent 实际使用的系统指令、工具与后续技能等运行配置；本 Run 期间保持不变。用户模型／思考选择变更独立提交 Meta，不等到发送才更新；普通发送沿用最新已提交选择。host 提供的初始选择仍沿用现有默认／首个可用模型规则，不写回全局默认设置。Agent 不检测或处理 LM worker 内同 model_ref 的配置变化，不引入 configuration_token 或跨调用配置门禁。

一次模型生成成功结束并取得完整工具调用后，才校验并执行工具；参数 delta 只用于展示，不作为可执行参数。工具结果保留调用 ID、名称、内容与错误语义，再加入下一次生成的上下文。首期顺序执行工具；工具上限及可选 Gen 上限按 Run 累计，超时与预算按保存的 RuntimeLimits／GenerationParameters 执行，达到限制进入可解释的终态，不无限循环。

只有已注册且满足授权条件的工具可以执行。授权绑定具体运行与调用；拒绝、停止或运行终止后，旧授权不能触发工具。工具异常与模型／通信异常分别处理；是否作为工具错误回传继续生成，按错误类别确定，不能吞错伪装成功。

每个会话同一时刻至多一轮写入型运行，重复提交可识别。隐藏／收起仅改变展示，不隐式停止；切换会话不把旧运行绑定到新会话。新建沿用现有“停止当前运行，再进入新会话”的语义；删除当前运行会话须先终止执行并阻止后续落库。首期允许不同会话各持有一轮运行，保留现有 LLM owner 的资源上限及拒绝语义，不增加任务排队产品能力；每会话仍串行，隐藏或切换不取消旧会话。

停止须到达模型流和工具执行上下文；不可取消的外部动作记录实际结果或结果未知状态，不承诺回滚。UI 订阅关闭不能等同于停止服务端运行，应用退出／崩溃后的恢复也不能自动重跑未知结果的工具。

## 后续对话控制能力的扩展边界

上述后续能力复用同一套会话、运行、输入与历史模型，不分别建立独立的消息通道。本期实现满足实际需要的最小结构；下表描述未来语义和必须避免的设计限制，不要求现在暴露对应 RPC。

| 能力 | 后续预期语义 | 本期保留的设计接入点 |
| --- | --- | --- |
| `FollowUp` | 当前 Run 正常完成后，按服务确认的 FIFO 消费已接纳输入，启动新 Run | InputMode／RunCause／消费关系在 01a 定义；失败、取消或达到硬限制时保持待处理，不自动拉起下一 Run。新 Run 重置执行预算；区别于旧版／Pi 在同一 loop 继续的语义 |
| `Steering`（即时引导） | 在当前 Run 的工具之间检查，下一 Gen 前插入补充指令 | 已启动工具先结算；检查到 steering 后，本批尚未启动工具记录 skipped 结果以闭合配对，再结束 Turn、在同 Run 下一 Turn 消费输入。无工具时在下一 Gen 前消费；不修改已发请求，不隐式停止当前工具／审批 |
| `Preempt`（抢占） | 立即请求取消当前 Gen／工具，在同 Run 下一 Turn 应用新指令 | Preempt 输入携带 expected_run_id；TurnEnded::Preempted 关联触发 Input，正在生成的 Gen 结算 Preempted，已经结束的 Gen 保留原终态。工具／交互先安全结算，不重置 Run 预算，不引入后台继续执行语义；实际调度／RPC 后续实现 |
| rewind | 将后续对话的上下文起点退回到指定历史边界 | 历史条目具有稳定 ID 与顺序，区分持久记录和当前有效上下文；上下文构建可按明确边界取历史。不得依赖覆盖旧消息或破坏性删除后缀作为唯一实现方式 |
| fork | 从指定历史边界创建可独立继续的新会话，保留来源关系 | 会话身份与历史条目身份分离，允许记录来源会话和分叉位置；历史内容与运行中状态分离，不能要求复制活跃任务、队列或授权才能继续新会话 |

共同约束：

- **输入状态可辨认**：未来启用排队时，须区分已接收、待消费、已消费与取消；确定消费归属并防止重复。steering 与 follow-up 是不同消费时机，模式在接纳时显式记录，不从文案或发送时间猜测。Run 收尾与输入接纳按会话串行判定：先接纳的 steering 必须进入收尾检查，Run 已终结则拒绝目标过期输入，不静默转 follow-up。重启重建未消费输入，绝不自动发送。
- **历史边界完整**：rewind／fork 只从可重建的边界产生后续上下文，不截断工具调用／结果配对。优先支持已完成用户轮次边界；更细粒度边界须满足 Turn 工具闭合，不以 GenEnded 代替安全边界。压缩记录须保留所覆盖历史范围与来源，避免未来只能恢复最新摘要而无法解释选定位置。
- **运行隔离**：在途运行固定其上下文起点与版本；未来 rewind 前须停止并结算当前运行，fork 默认取已提交的历史边界。旧事件仍属于原运行，不得写入退回后的上下文或新会话。并发检查可用 revision／预期历史位置实现，具体字段在契约切片确定。
- **外部副作用不随历史回退**：rewind 不等于撤销文件修改或已执行操作；fork 不重放历史工具，不继承在途任务或一次性授权。副作用回滚若需要，作为独立能力设计并验收。
- **存储可演进**：本期可保留线性历史，但须有稳定条目身份、schema 版本和独立的上下文构建入口。未来采用复制历史或共享不可变前缀，在 fork 实施时按数据量与附件生命周期决定；不提前建设 DAG 存储，也不把数据库行号、数组下标或渲染顺序作为业务身份。

扩展性验收以本期真实接口与数据模型为依据，检查上述接入点是否存在，以及增加能力是否需要改写既有历史语义；不为尚未交付的行为编写假实现或声称已完成运行时验证。

### Preempt 的执行边界与即时打断的上游参考（设计待实施）

本节不改变已确认的普通 steering 时机。核对 Codex b741e480 的 features/src/lib.rs：InstantInterrupt（instant_interrupt）为 UnderDevelopment、默认 false；session/mod.rs 仅启用时为 step 创建 preempt token，input_queue.rs::watch_user_input 在新用户输入到达时取消它。turn.rs 抢占当前生成／重试等待，再消费输入并继续同一 Codex Turn（对应我们的 Run）；Responses lite 可以发送 interrupt 后排空剩余响应，其他路径可停止读取。工具侧并非一律强杀：已经派发的直接工具可能仍需 drain，code-mode exec／wait 可以让前台等待返回，后台 cell 继续。不能把该设计描述为所有 Gen／tool call 都立即停止。

Pi 11449730 的 Agent.steer 只 enqueue，AgentSession.steer 在轮次边界注入；最新 agent-loop 顺序工具循环不再具有旧 XiaoWei 那种每个工具之后检查 steering 并跳过余下工具的逻辑。更强的停止通过 Agent.abort／AgentSession.abort 传播 AbortSignal 并等待 idle，再另发 prompt；工具能否及时终止取决于其 signal 实现。这是 abort 后新执行，不是普通 steer 的原子即时切换接口。

另有不依赖 InstantInterrupt 的手动路径：tui/chatwidget/interaction.rs 在 interrupt 快捷键（Esc）且存在 pending_steers 时设置 submit_pending_steers_after_interrupt 并发送 interrupt；input_restore.rs::on_interrupted_turn 在收到旧 Turn 中断后立即重新提交这些输入。它结束旧 Codex Turn，再开始新 Turn（对应我们的旧 Run → 新 Run），与自动抢占保留同 Turn 是不同生命周期。普通 follow-up 队列并非在所有 Esc 场景都自动提交，须区分 pending steering 与普通排队输入。

2026-10-03 用户要求把 InstantInterrupt 也加入设计，采用简短名 Preempt（抢占），作为 InputMode 的独立值；它保留当前 Run，区别于 StopRun 后重新发送的新 Run。01a 定义历史字段、状态和 fixture，产品调度／RPC／UI 仍后续实施；不新增切片。

Preempt 先持久接纳输入并验证 expected_run_id，再立即发出当前调用的取消请求。当前 Gen 尚在生成时结算 GenStatus::Preempted，直接记录 preempting_input_id，保留真实开始／首个 SSE／结束时间和 Partial；当前 Gen 已成功、正在执行工具时不改写 Gen 终态。当前 Turn 以 TurnStatus::Preempted 结束并保存触发的 preempting_input_id；下一 Turn 通过 InputConsumed 引入新指令，Run ID 与累计预算保持不变。处于 Turn 之间时直接在下一 Turn 消费，不伪造一个被抢占的 Gen／Turn。多个请求按同会话串行边界处理，终态只提交一次，已终结 Run 的目标请求冲突，不改成 follow-up。

工具接收取消，已完成的真实结果保留，尚未启动项补 skipped；等待中的 Interaction 以 Preempted 失效并直接保存触发的 preempting_input_id。抢占请求立即发出，下一 Gen 须等当前调用和工具配对完成安全结算；不能仅 drop future 就声称外部进程已终止。无法确认调用结束时仍显示待结算，不在后台偷偷脱离执行，也不启动下一 Gen；无法取得结果的已结束动作明确为 ResultUnknown，并禁止自动重做等价副作用。这里不建设 Codex code-mode 的后台 cell／前台 yield 机制。源调用的迟到事件只归原 Gen／ToolId，不修改新 Turn，不覆写已提交终态。

InputAccepted(Preempt) 表示接纳，TurnEnded(Preempted) 表示原轮抢占完成，InputConsumed 表示新指令进入下一轮上下文；新 GenStarted 才表示已提交给模型。三阶段状态不可合并为客户端即时“已生效”。

## Chat UI 与交互

沿用 `QuickChatTransition`、Launcher 原生尺寸协调、菜单／Modal 的 Esc 优先级、输入法保护与滚动跟随规则。真实会话列表替换 preview mock；归档／删除最后一个可见会话回到空态，切换会话时隔离草稿、滚动和运行事件。首期草稿与滚动位置按会话保存在 renderer 内存，刷新后不恢复，不与消息持久化混为一谈。

消息按内容块顺序呈现正文、思考与工具卡片，工具状态包含等待、执行中、成功、失败、取消或结果未知；授权操作有明确目标和结果。区分等待首字、模型生成、工具运行与整轮终态，输出后不恢复已被用户移除的冗余“正在生成”文案。

纯文本正文、可折叠思考、模型选择与发送／停止已接产品；本轮 composer／hint 按用户要求跳过 Storybook，不重复规划。Markdown／代码块、消息复制仍由 03a 实施；后续工具详情、授权和压缩／继续状态复用现有组件，按相应切片覆盖长内容、窄窗口、明暗主题及异常状态并验收新增视觉。本期按已确认范围保留 textarea，不引入新的编辑器依赖。

## 可观测性与验证

复用现有日志机制，以会话、运行和调用 ID 关联模型调用、工具执行、授权、停止、持久化失败和最终结果；记录阶段与安全错误原因，不逐 token 打日志，不记录凭据或默认倾倒用户消息／工具参数。

自动验证分层覆盖 core 状态机、真实 typed Gateway 边界、storage 重启恢复和 UI 交互。关键用例包括交错内容块、多工具循环、开流前停止、工具中停止、授权迟到、worker 断流、renderer 重连、删除与迟到写入竞争，以及重试不会重复工具副作用。实际产品验收从 Quick Chat 入口完成，遵循仓库实例规则，不由 Agent 冷启动应用。
