# 运行、工具、扩展能力与 Chat UI

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。本文是同一 record 的专题附件，状态与范围由主 record 管理。

基础文本、JSONL、Host、composer、Read／Write／Edit、Glob／Grep 及 macOS 前台 Bash 已接入；前三批工具的窗口及重启验收见[实施结果](implementation-results.md)。问答／权限及对应 UI 已实现，本批功能链路与窗口验收已完成，平台复核边界见交付结果；其他工具及扩展能力仍待实施。持久配置与 Run 快照按[宿主接口复核](host-interface.md)的已确认调整实施；不追踪 worker 内同引用配置的版本。

## 当前执行

Quick Chat 已经 Agent typed client → xiaowei-agent → xw-agent → runtime → 注入的 Llm.Generate adapter 执行。每个 Run 可包含多个 Turn／Gen，顺序执行文件工具和前台 Bash，无自动重试。完整合法 TOOL_USE 结束 Gen 后提交工具意图并执行，结果提交并闭合 Turn 后才继续生成；STOP／LENGTH 的完整有效且无工具调用的消息结束 Run，不保证有可见正文。完整成功消息与已提交结果进入后续模型历史；EOF、模型失败、非法／不支持输出为 Failed，取消为 Interrupted。失败／取消的用户输入保留，部分回复只用于显示。

聊天 runtime 在 adapter 的流读取返回后复核取消 token；读取过程中已发生的取消优先于同时返回的 EOF、错误或最终消息，避免停止被误判为 Failed，或把取消后的最终消息写入模型历史。

Gen 开始／结束和单调耗时在所有退出路径采集；支持 fetch 观察的 worker 路径提供真实首个 SSE data event 时间，其他路径保持未知。聊天 Gen 生命周期与最终完整／部分消息写 JSONL。详情见[Host 观测](host-interface.md#生成流与观测)。

renderer 保留草稿／显示缓存，Rust 持有权威历史与运行。隐藏／收起／观察 cleanup 不停止 Run；新对话先请求停止并等 RunCompleted，然后进入空对话并保留旧会话；普通切换不停止旧 Run；删除仅清理所选会话。实例关闭取消并等待执行，随后释放 endpoint，再关闭 LLM；生产 Agent.open 关闭／重开恢复已提交历史。停止请求失败会显示未确认提示。

UI 沿用现有 textarea 和空态，正文已接 Markdown／代码块及原文复制，思考默认末行摘要并可展开；正文、思考与现有工具按有序 Item 展示。未生成标题时首条输入作为显示标题；标题能力和 composer 模型／思考控件已接入，Host hint／保存行为见[宿主接口](host-interface.md)。新消息展示已完成当前工作区真实 sol 模型、系统复制及重启恢复验收，见[本批证据](implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。

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

## 工具循环与后续完整运行

Run 开始时捕获已提交会话配置中的模型引用、思考强度和独立的提供商／模型展示名称，以及 Agent 实际使用的系统指令、工具与后续技能等运行配置；本 Run 期间保持不变。用户模型／思考选择变更独立提交 Meta，不等到发送才更新；普通发送沿用最新已提交选择。host 提供的初始选择仍沿用现有默认／首个可用模型规则，不写回全局默认设置。Agent 不检测或处理 LM worker 内同 model_ref 的配置变化，不引入 configuration_token 或跨调用配置门禁。

一次模型生成成功结束并取得完整工具调用后，才校验并执行工具；参数 delta 不作为可执行参数，当前也未投影成公开工具参数流。工具结果保留调用 ID、名称、内容与错误语义，再加入下一次生成的上下文。首期顺序执行工具；工具上限及可选 Gen 上限按 Run 累计，超时与预算按保存的 RuntimeLimits／GenerationParameters 执行，达到限制进入可解释的终态，不无限循环。

只有已注册且满足授权条件的工具可以执行。授权绑定具体运行与调用；拒绝、停止或运行终止后，旧授权不能触发工具。工具异常与模型／通信异常分别处理；是否作为工具错误回传继续生成，按错误类别确定，不能吞错伪装成功。

每个会话同一时刻至多一轮写入型运行，重复提交可识别。隐藏／收起仅改变展示，不隐式停止；切换会话不把旧运行绑定到新会话。新建沿用现有“停止当前运行，再进入新会话”的语义；删除当前运行会话须先终止执行并阻止后续落库。首期允许不同会话各持有一轮运行，保留现有 LLM owner 的资源上限及拒绝语义，不增加任务排队产品能力；每会话仍串行，隐藏或切换不取消旧会话。

停止须到达模型流和工具执行上下文；不可取消的外部动作记录实际结果或结果未知状态，不承诺回滚。UI 订阅关闭不能等同于停止服务端运行，应用退出／崩溃后的恢复也不能自动重跑未知结果的工具。

当前 `run_loop` 位于拥有 Journal 和公共投影的 xw-agent，runtime 收集单次生成并提供文件原语。默认每 Run 50 次工具调用，不额外限定 Gen 数量；超限、非法完整输出及截断参数不会执行。工具结果失败仍与调用配对并可交给模型处理；必需记录提交失败立即终止，不继续下一次 Generate。已启动文件操作在 blocking pool 执行，停止后等待实际结果，未启动项保存 skipped；不可把停止提示当作已撤销写入。

本批 Read 仅文本，保留编号、分页、输出上限、allow_missing 和读取去重；Write 覆盖并创建父目录，Edit 默认精确唯一匹配，replace_all 显式允许多处替换。写权限先于 mkdir 等副作用检查；默认 cwd、临时目录及有效历史授权可写，home 及其祖先不能作为默认整棵目录授权。未开放的工具／命名空间和非法参数产生关联错误；工作区内 `.git` 不额外禁写，PDF 另列后续。

工具 Item 保存 ToolId、Turn／Gen、provider call ID、参数、状态、输出、diff metadata 和实际耗时。恢复展示已提交结果及 result_unknown，普通新 Run 遇到未闭合工具历史返回冲突，等待后续显式 Continue 实施；不会自动重放副作用。

### 问答与权限卡片（第 4 批）

2026-10-25 用户要求继续对齐 AskUserQuestion／RequestPermission 及 03c 对应 UI，并明确 AskUserQuestion 的自由文字回复同时支持卡片和下方输入框。2026-10-26 已联合实现两个工具、两阶段协议及对应产品 UI，不等 03d；完整长输出仍等 01f。实现与验证进度见[交付证据](implementation-results.md#问答权限与对应-ui2026-10-26)。

参考旧仓库 `~/Develop/XiaoWei/workspace/src/xiaowei-next`，HEAD `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3`，核对时无未提交改动。已读 runtime 的 tools/core/{ask_user_question,request_permission}.rs、permission.rs，UI 的 chat/parts/tools/{AskUserQuestion,RequestPermission}.tsx，以及 chatStore、quickChatStore、studio chat/commands.rs、xw-agent-app/interactive.rs 的回应与持久化路径。

旧问答保留 question、options、multi_select，执行时最多 12 个选项；卡片单选点击即提交，多选勾选后提交。旧 chatStore 会把输入框文本路由为待答交互的回应，不增加可见用户气泡；旧 Quick Chat 的 sendMessage 没有同样的文本拦截。本次按用户要求让实际 Quick Chat 的卡片自由输入和下方输入框都可回答，双方共享按 InteractionId 隔离的文本／选择／提交状态，保留原普通聊天草稿。

旧工具以 metadata 卡片和 stop_loop 结束循环，回应随后另开 Run，并以 Meta 用户消息继续；旧批准路径先保存授予范围，并在会话重开时恢复。本次沿已确认的两阶段协议，改为 xw-agent 在同一 Run 的工具执行阶段等待 typed 回答，再提交对应工具结果并继续。Question 回答不产生新的普通用户消息或 StartRun；权限只由已关联请求的批准／拒绝决定生效，不迁入模型可自报同意的 GrantPermission。此为明确的生命周期与授权适配，不宣称原样迁移。

公共 Interaction 附在原 ToolCall；UI 将该 Item 投影为独立交互块，保持执行位置与稳定身份，作为普通工具组的边界。待答内容默认展开，不能藏在默认折叠的工具组／详情中；已解决后显示简短回答／决定摘要，可展开核对问题、选择或路径。沿用当前无横向缩进、就近错误提示、无单工具耗时及整轮完成后仅显示总用时的规则，不增加通用审批弹窗。

| 情况 | 展示与操作 |
| --- | --- |
| 等待问题回答 | 显示问题及可选选项；单选点击提交，多选勾选后提交；卡片与 composer 均可输入自由文字，无选项时仍可回答，也支持选择附补充文字 |
| 等待权限决定 | 显示服务解析后的完整目标、文件或目录子树范围和理由，以及批准／拒绝；已批准范围在本会话后续及重开后有效，不让客户端提交更大的路径 |
| 等待用户 | Run 仍进行中但当前 Generate 已结束；卡片不显示模型流光或 3 秒“等待模型响应”。停止原 Run 仍可用；待答 Question 的 composer 同时可发送回答 |
| 决定提交中 | 卡片与 composer 共用提交锁；禁用重复决定，保留文字和选择。只显示提交状态，不乐观标记已回答／获准 |
| 回应失败或未确认 | 卡片附近显示错误并保留草稿；先同步公共状态，再以同一幂等 ID 重试原决定。另一端已解决时显示实际结果并关闭旧操作 |
| 已回答／批准／拒绝 | 显示已提交摘要、禁用原操作；普通拒绝仍是有效工具结果，交给模型继续处理，不直接当作整轮执行失败 |
| 停止、关闭或恢复失效 | 显示真实原因且不可再作答；迟到投递／回应不能重新开启请求。窗口隐藏、切换会话或单端观察结束不自动拒绝交互 |

composer 仅在有明确 pending Question 时将发送路由到 RespondInteraction，其余运行阶段保持既有发送限制。卡片及 composer 的回答草稿按 session／interaction 隔离；进入／离开回复模式不清空普通聊天草稿，提交或失效后恢复普通草稿。两个入口不互发普通聊天消息，不共用另一次生成的 pending 输入。按当前键盘／IME 保护处理 Enter／Shift+Enter，回答与 Stop 分开，不能把 Run 提前显示成已结束来解锁输入。

权限继续使用当前真实路径和 symlink 检查，不放宽默认可写范围。批准提交后刷新当前 Run 的 grants 与 FileTools，保留 Read 去重；Bash 下一次启动使用新的授权快照，已启动进程不追溯扩权。有效批准持久化，未决定的请求在重启时失效；恢复不自动开始生成或重放外部操作。已知交互工具在恢复时从持久回答补结果或补取消，不按未知外部副作用阻止后续普通 Run。

### Run 阶段与内容排列（2026-10-25，源码复核）

本节结合源码与本批产品接线梳理阶段及内容排列，实际验收范围见[交付结果](implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。一个 Run 对应一次已接纳的用户任务，可以经历多次模型生成与工具执行循环。主要流程为可选思考、本次 response（正文与工具声明均可选）、完整生成校验、工具执行；中途随时可能失败或停止。适配器允许多种内容块顺序，但没有实际样本证明当前 sol 经常任意思考／正文／工具交错，不将所有协议可表达的排列当作常规阶段。

| 阶段 | 需要覆盖的情况 | 当前行为与展示边界 |
| --- | --- | --- |
| 提交与接纳（Run 之前） | 首次创建会话；正常接纳；输入／配置／会话状态／容量／存储拒绝；响应丢失导致结果未确认 | 同会话不排队；相同 input_id 与相同请求返回原 Run。未确认发送不自动重发，先同步是否已接纳；不能把发送失败统一画成 Run Failed |
| 等待本次模型输出 | 首次生成或工具后的再次生成；尚未开流；已收到事件但无可见内容；只有工具参数或不可见思考 | 每次生成独立计时。公开 generation 区分尚未收到内容、已有内容和活跃 Item；首 SSE／控制事件不计内容，收到工具声明但无可见块时继续流光 |
| 模型生成内容 | 可选思考后输出正文和／或工具声明；直接声明工具；正文在声明之前或之后；中途暂停、停止或失败 | 先投影本次 response，完整生成结束并校验后才执行工具；工具声明不等于执行，参数尚未完整时不执行 |
| 本次生成结束与校验 | 完整合法且无工具调用；完整合法工具调用；参数截断／非法 JSON／重复调用 ID；缺少 Finished 的 EOF；不支持的输出 | 无工具的合法 STOP／LENGTH 进入 Run 收尾；合法 TOOL_USE 进入执行。非法工具调用使本次生成失败，整批不执行；当前 LENGTH 没有自动 Continue |
| 工具执行与结果提交 | 单次或连续调用；同名或不同名；参数相同或不同；全部成功、部分失败、停止、未执行或结果未知 | 当前串行；逐项提交 intent、发布 Pending、执行并提交 result，不预先发布整批待执行项。普通工具失败可回传模型，后续调用仍可执行；结果未知或必需记录失败会终止继续 |
| 工具后再次生成 | 直接回复；先思考再回复；不输出正文而继续调用工具；先说明再调用；反复多轮 | 本批工具结果全部提交后才再次请求模型。同一批工具实际执行期间没有新的模型正文穿插；不同 Gen 之间可以没有可见分隔 |
| Run 收尾 | 最后正文已停止增长但仍在结算；无可见最终正文；结算失败；与停止请求竞争 | 最后一段文字完成不等于 Run 已完成，以 RunCompleted／终态快照为准。记录失败仍可转 Failed；自动标题在 RunCompleted 后单独执行，不属于聊天 Run 阶段 |
| 终态 | Completed、Interrupted、Failed；有／无部分回复；有／无工具异常 | Run 结果与每个工具的结果分别保留。Completed 允许包含失败后被模型处理的工具；Interrupted 也可能包含实际已完成的写入 |

内容排列用 `A` 表示助手正文，`R` 表示可见思考，`T1`／`T2` 表示两次独立工具执行及其结果。下表描述 Run 展示序列，不把单次 Generate 内的工具声明位置当作工具已经执行的位置。

| 排列 | 场景及分组关注点 |
| --- | --- |
| `A`、`R → A` | 零工具；不能假设每次都有可见思考 |
| `T1 → A`、`A → T1 → A`、`R → T1 → A` | 单次调用，调用前可无正文、有说明或有思考 |
| `T1 → T2 → A`，T1／T2 同名 | 连续调用相同工具；即使参数也相同，展示上仍按各自调用 ID 保留，不按名称或参数去重；不改变 Read 等工具内部已有的读取去重 |
| `T1 → T2 → A`，T1／T2 不同名 | 连续调用不同工具；名称变化不自动分组，连续性才是工具组边界 |
| `A → T1 → T2 → A` | 两段正文之间存在一组多次调用；工具详情与外层整轮过程折叠是两层机制 |
| `T1 → A → T2 → A` | 中间正文保持原位置，分隔两段工具活动，不拼到最终回复后面 |
| `T1 → T2 → T3 → A`，跨多次 Gen | 后续生成没有可见正文／思考，直接继续调用；UI 上可以仍为连续工具，不能仅凭 Gen 边界拆组 |
| `T1 → R → T2 → A` | 没有正文但有可见思考；当前展示将思考作为组边界，Codex 参考会过滤普通 reasoning 后再组合活动，此差异仍须明确 |
| `A → T1 → T2 → A → T3 → R → T4 → A` | 多组、单项与混合工具、正文／思考交错；各段独立增长、结束及展开，不按种类汇总 |
| 调用后没有可见最终正文，或仅有 R／空白可见内容 | 当前合法无工具生成可结束 Run；不能把最后一次工具前的说明冒充最终回答，也不能因为没有正文就持续显示执行中 |

“连续工具”还须区分两种实际执行过程：单次 Gen 返回多个声明，执行完这一批后才再生成；或每次 Gen 只返回一个声明，工具结果返回后，下一 Gen 不输出可见文本而继续声明工具。二者在界面上可以形成相同的连续工具组。若一个 Gen 本身返回 `call(T1) → A → call(T2)`，A 是收到这批工具结果之前生成的文字，不是执行 T1 后对结果的解释。按用户确认，仍先投影该次 response，再执行 T1／T2 并投影工具结果，不为还原声明位置提前插入工具执行行；这属于所需执行时间线，不再认定为 harness 丢序缺陷。必须保留的是跨 Generate 的 response、工具执行、下一次 response 的先后关系，不能在 renderer 按种类汇总。工具输出属于工具详情，不作为分隔工具组的助手正文。

### 根据当前 Generate 状态驱动展示

不能仅用“Run 进行中 + 最后可见块”推断输出状态；由 harness 已知的当前 Gen 身份、块开始／结束及生成终态驱动，工具执行单独使用工具状态。公开 Run 现包含当前 Generate 的身份、开始时间、已收到内容和活跃 Item；`GenerationUpdated` 与 Item 事件共用有序订阅及原子首帧快照。首 SSE／控制事件不算内容；工具声明只改变生成状态，不提前创建执行中工具 Item。生成结束先停止相应流光，再执行合法工具；后续 Generate 使用新身份及独立等待计时。正常 Run 终态提供最终 Gen，renderer 以响应 Item 的 Gen 归属选出最终正文，空集合与缺少边界信息不同。当前状态仅在内存投影中同步，终态关联从已有 GenStarted／GenEnded／RecordedMessage 重建，不修改 Journal 格式，也不依赖 provider 的可选 phase。

| 当前 Generate／执行状态 | 展示要求 |
| --- | --- |
| 本次 Generate 尚未收到内容 | 先只显示流光；从本次 Generate 开始超过 3 秒仍无内容，显示“等待模型响应”。开始／心跳等控制事件不等于收到思考、正文或工具声明 |
| 思考块开始或持续收到 delta | 仅当前仍活跃的思考显示流光，数据停顿时保持；块结束后停止 |
| 正文块开始或持续收到 delta | 仅当前仍活跃的正文显示流光，数据停顿时保持；块结束后停止 |
| 工具声明／参数生成中 | 不当作工具已经执行；已收到内容但没有可见活跃块时保留流光，不再因停顿超过 3 秒恢复等待文案，也不给旧 Generate 的正文加流光 |
| Generate 完整结束且有合法调用 | 本次正文／思考停止流光，按每个工具实际 Pending／终态更新；不把 Gen 完成当作 Run 完成 |
| 工具结束，下一次 Generate 开始 | 切换当前 Gen 身份与等待状态；已完成工具保持静态，迟到事件不得激活旧 Gen |
| Generate 完整结束且无工具调用 | 本次输出停止流光，等待 Run 收尾确认；正常结束后将该次 response 正文作为本轮最终回复。空／空白回复显示“未返回回复内容”，过程仍可展开，不把之前说明当回答，也不提供复制回复按钮 |
| Generate 失败或取消 | 停止对应输出效果，保留已有内容，分别表达失败／停止；不改变已经结算的工具结果 |

runtime 收到 Started、BlockStarted／BlockFinished、正文／思考／参数 delta、Finished／Failed，并由取消 token 识别取消；当前 Gen 身份由 harness 持有。本批已将生成状态投影给产品 UI，原子首帧快照包含相同权威状态，重连无需重放旧事件恢复活跃块。每次 Generate 独立计算首次内容等待，上一 Gen 已有数据不取消下一 Gen 的 3 秒规则；本次一旦收到思考、正文或工具声明，后续数据停顿只继续流光。这里的停顿区别于显式停止、失败或生成结束，后三者仍须结束对应流光。LENGTH 虽然当前使 Run 进入 Completed，仍应区别于完整正常回答，不因文字已停就抹掉截断语义。

状态与上述排列交叉覆盖：

- 生成前／生成中停止：保留已显示的部分文字，未校验完整的工具声明不执行；当前没有公开的参数流 Item 可展示为“已停止的执行”。
- 批内一项失败：保留失败项及真实输出，后续项仍可执行；模型可以解释失败、换参数重试同名工具或调用其他工具，最终 Run 仍可能正常完成。Bash 普通非零退出以 Completed 加退出码返回，不统一归为工具 Failed。
- 工具执行中停止：先等待已启动操作结算，记录实际完成或取消；剩余尚未启动项记录 Skipped，不回滚副作用。停止 RPC 返回只确认请求，不代表已经结算。
- 工具结果未知或存储失败：不能继续生成或自动重跑；后续尚未提交的声明可能尚未形成公开 Item，不承诺全部显示为 Skipped。
- 工具全部完成、正在等待下一次模型生成：Run 仍在进行，但工具已不处于 Pending；不能继续给已结束工具加执行中效果。
- 输出正文时失败或最后结算失败：保留部分内容并显示 Run 错误，不能仅凭有正文判成功；未完成消息不进入后续模型上下文。
- 隐藏／切换会话／观察断连：不改变 Run；重连用首帧权威快照恢复，不重发用户请求或重新执行工具。断连是观察状态，不是 Run 终态。
- 应用崩溃／重启：恢复已提交记录，未提交的流式片段可能丢失；未结算 Run 恢复为 Interrupted，已有 intent 而无结果的工具保持结果未知，不自动重放。未闭合工具历史会阻止普通新 Run。

本次对齐后的结论与现有缺口：

1. **单次 response 与工具执行分开投影符合要求**：正文／思考先投影，合法完整工具调用再逐项执行并追加工具 Item。撤销此前将其归类为“同次生成内工具交错丢序，必须修复”的判断；不改变模型历史的原始内容块及调用／结果配对。
2. **当前活跃阶段已按 Generate 接线**：公开 Run 及 GenerationUpdated 提供当前 Gen／块生命周期，快照包含相同权威状态；产品与预览共用展示路径，覆盖等待、停顿、工具后新生成及终态，不恢复末块推断。
3. **最终回答不等于必须存在 final_answer 字段**：这里指本轮正常结束时呈现给用户的最后回复；当前可按结束 Run 的最后一次无工具 Generate 识别，运行中不提前判定。另有 Codex／部分 Responses 输出中的可选 phase 标记，用于细分 commentary 与 final_answer。已安装的 Pi 0.87.1 在 `dist/api/openai-responses-shared.js` 将该 phase 编码进 textSignature，我们的 worker 映射为 TextContent.signature，Rust 模型历史继续保留；公开 AgentMessage 只投影 text，UI 尚未取得该信息。因此“公开 UI 未暴露”不代表 Pi 或底层一定没有。该标记并非所有 provider 的统一保证，不将新增同名字段作为本批展示前置。
4. **当前没有工具输出流或整批待执行投影**：不展示假实时 stdout，也不将尚未公开的后续声明数量当作已接纳执行数。AskUserQuestion／RequestPermission 已接同 Run 等待与继续；压缩、Continue、后台工具及运行中补充输入仍为后续能力，不混入当前已实现阶段。

依据：[Run 接纳与公开投影](../../../../crates/xw-agent/src/execution.rs)、[Run 循环与工具提交](../../../../crates/xw-agent/src/run_loop.rs)、[单次生成与最终消息校验](../../../../crates/xw-agent-runtime/src/text.rs)、[恢复投影](../../../../crates/xw-agent/src/persistence.rs)、[中断恢复](../../../../crates/xw-agent/src/recovery.rs)、[Pi 事件映射](../../../../desktop/src/main/services/llm/worker/events.ts)、[Pi 消息映射](../../../../desktop/src/main/services/llm/worker/messages.ts)及 [renderer 事件投影](../../../../desktop/src/renderer/src/components/agent-chat/agent-events.ts)。自动验证、可控预览与真实 sol 窗口覆盖的范围分别记录在[本批证据](implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。

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

此前产品按 Run 汇总正文／思考、再列工具详情，丢失了正文与工具的交错关系；03a／03c 的预览经用户确认后已接产品，直接按有序 Item 渲染，现有工具使用紧凑可展开行。问答／权限仍待后续。区分等待首字、模型生成、工具运行与整轮终态，输出后不恢复已被用户移除的冗余“正在生成”文案。

2026-10-25 用户确认预览并要求实施，实际 `AgentItem` 与 Generate 投影已接入同一 QuickChatPanel／AgentMessage。每个正文／思考／工具保留收到的 Item ID 和顺序，工具终态替换原块，快照与增量共用转换；旧聚合字段和临时 renderMessageContent 分派已移除。同次 response 先投影、再执行工具的顺序保持不变。GFM／代码／表格、正文与代码复制、参数／输出分离及已有文件 diff 已接，剪贴板及链接复用 System typed client，组件不持有 Gateway。自动回归、浏览器及当前工作区实际窗口验收已通过；真实 sol 模型核对工具分组、正文与代码复制、停止、失败、Edit diff 和重开不重放，具体证据与限制见[交付结果](implementation-results.md#有序消息与现有工具-ui2026-10-25产品接入与验收)。

消息下方按用户要求在复制按钮右侧显示相对时间；用户消息发送后显示，助手消息在运行终态显示，最终回复为空时只显示时间而没有回复复制按钮。时间取 Run 已记录的 startedAtMs，不用工具耗时、完成时间或渲染时刻代替。格式与刷新规则来自旧版 `xiaowei-next` 的 `xiaowei/src/utils/format.ts::formatRelativeTime`、`components/chat/RunFooter.tsx`／`MessageBubble.tsx` 和 `hooks/useNowTick.ts`：小于 1 分钟为“刚刚”，之后按分钟、小时、天、30 天的月、12 个月的年取整，每 30 秒刷新；不改成绝对时分或“昨天”。只调整用户指定的位置，不迁入旧 footer 的模型、token 或工具次数。

Storybook 从 18 个入口收敛为 12 个：按首次等待、收到内容后停顿、无工具回复、单工具、连续工具、工具间正文、空最终回复、工具失败后正常结束、Run 失败、用户停止、Markdown／复制和长内容区分。相同／不同工具、重复参数、跨 Generate 无正文、工具执行／等待／回复／完成、失败和停止位置均作为对应场景控件；明暗与窄屏不再各复制一份 Story，复制／链接失败也作为控件。去掉把 Pending、Skipped、ResultUnknown 等互斥执行事实拼成同一 Run 的旧工具状态场景。场景名称、可选值和具体 mock 以相邻 [stories](../../../../desktop/src/renderer/src/components/quick-chat/QuickChatMessages.stories.tsx) 与 [fixture](../../../../desktop/src/renderer/src/components/quick-chat/message-preview-fixtures.ts) 为准。

### Codex 桌面参考与本批适配（2026-10-25）

按用户要求读取本机 `/Applications/ChatGPT.app/Contents/Resources/app.asar`；其包名为 `openai-codex-electron`，版本 `26.1013.40934`。依据为包内 `webview/assets/` 的发布 JS，而非 TUI 推断；相关 sourcemap 未随包提供。只提取选定资源用于阅读，没有改动已安装 App。此前提供的 TUI／AstraBuddy 两篇笔记没有证实 Codex 桌面的折叠规则，不作为本节依据。

| 发布资源 | 核对到的行为 |
| --- | --- |
| `local-conversation-turn-918111aed944.js` | 分别渲染 `agent-activity` 与最终 `assistant-item`，识别助手消息的 `phase === "final_answer"`；执行过程与最终回答具有独立边界 |
| `sites-end-resource-8a7a3656de67.js` 的 `Lk`／`Rk` | 有可显示活动，且允许提前折叠，或最终回答已开始且未取消时，才允许折叠；实际折叠还受强制展开、禁止自动折叠及已保存／手动选择控制，不是所有 Completed 一律收起 |
| `collapsed-turn-disclosure-5ab38617e1bb.js` | 以轻量文字行、箭头和分隔线展开过程；有真实耗时则显示 `Worked for`，否则显示此前消息数；可附带被拒动作计数 |
| `agent-activity-item-52caeab690d6.js` 的 `dr`，`inline-followup-markdown-8cb3de7e61c6.js` 的 `N`／`P`／`Xe`／`Ye` | 先区分可分组与独立活动，再按源顺序组合相邻项；正文是独立项，普通 reasoning 不直接进入该活动列表。分组 key 优先采用原 ID／callId；运行中展示活动项或思考提示，闭合后展示汇总，适用的单项组还原为独立行 |
| `sites-end-resource-8a7a3656de67.js` 的 `nk`／`A_` | 工具组使用独立展开状态，默认收起，点击显示组内原顺序内容；与整轮过程折叠是两层不同机制 |
| `inline-followup-markdown-8cb3de7e61c6.js` 的 `Ae`／`je`／`Pe`，`sites-end-resource-8a7a3656de67.js` 的 `ak`／`uk`／`wv` | 结束后的组标题按动作类别构造有序摘要，读取／搜索／列文件合并为 exploration，文件改动与命令另列；图标取首个摘要类别对应的活动。部分 count 只决定英文单复数，不显示调用数字，不按原始工具名称逐项拼接 |
| `active-tool-activity-label-d467b18ec088.js` 的 `D`／`O`／`k`，`sites-end-resource-8a7a3656de67.js` 的 `ak`／`sk` | 活跃组优先查找最新未结束的动作，按动作类型和目标格式化，例如读取文件名、搜索目标或执行命令，并使用流光；结束摘要不保留最后一次调用的参数 |
| `local-conversation-turn-918111aed944.js`、`app-initial-90eb42395b7d.js` 的 `g$a`（导出别名 `m0t`） | 从最新 reasoning 向前查找可用末行，忽略空行／注释，经 Markdown 转为可读文本，供当前思考提示使用；不是只显示固定“思考过程”标签 |
| `agent-activity-item-52caeab690d6.js`、`timeline-activity-body-f9766fa30e89.js` | 活动支持紧凑行、摘要与展开正文，详情使用缩进及紧凑间距；不为每次调用固定套独立边框卡片 |
| `sites-end-resource-8a7a3656de67.js` 的 `zx`／`activeCommentary`、`app-shared-dc7535e633d7.css` 的 `loading-shimmer` | 活动说明支持文字流光，当前工具／思考提示使用相同方向的动态状态表达；CSS 包含减少动态效果处理。本批复用项目语义颜色实现，没有照搬其主题变量及动画组件 |

Codex 还会把未解决的用户交互及部分需持续展示的工具内容保留在可折叠过程之外。本批没有问答／权限 Item，不提前实现这套分流；接入 02f 时再按实际状态处理。

本批借鉴“过程／最终回答分开”和紧凑工具行，但不照搬 Codex 的全部条件。当前公开 Item 未暴露 `final_answer`，不代表底层一定缺失该信息；Pi Responses 的可选 phase 保留链路见前述复核。按用户确认，无 toolcall 的最后一次 response 是最终回答；Harness 在正常终态提供最终 Gen，renderer 选取同 Gen 的正文块，不用最后工具之后的文本后缀猜测。仅在 Run 正常完成后折叠其他过程块，最终回答为空也不挪用前面的说明；运行中、停止或失败保持过程可见。只有思考前缀、没有工具的完成回复也可折叠该前缀。不新增 Codex 同名模型阶段字段。

用户根据截图进一步明确：整轮完成后的过程折叠入口只显示总用时及箭头，例如“用时 3.2 秒 ›”，不显示“执行过程”、工具次数或异常计数。总用时取 Run 已记录的 completedAtMs − startedAtMs，包含本轮模型与工具执行，不累加各工具耗时；缺少有效时间时仅显示“查看过程”，不伪造时长或回退为调用次数。单个工具和连续工具组仍不显示耗时；组内异常提示保留，异常计数并非 Codex 的被拒动作计数。

工具标题由共享 `tool-presentation.ts` 格式化。单条依次显示工具图标、动作与目标、必要的异常／停止提示和尾部箭头；文件动作显示 basename，完整路径仍在 tooltip 与参数详情中。组执行时取当前 Pending 工具的动作／目标；结束后按参考的类别顺序汇总：Write／Edit 合为“修改文件”，Read／Glob／Grep 合为“读取文件”，Bash 为“执行命令”，不同类别用顿号连接，重复调用不重复标题。未知工具的单条回退为“调用 工具名”，组内归为“调用工具”；组图标取首个摘要类别。当前六个工具按此做中文适配，没有照搬 Codex 的命令解析、插件或技能专用标题；异常计数、停止提示仍独立显示。

折叠只隐藏稳定 Item 节点，不改写或按种类拼接内容；展开恢复收到的执行时间线 Item 顺序，不还原单次 Generate 内的工具声明位置。按用户要求不增加过程、工具组或工具详情的横向缩进，组标题、组内工具图标及参数／输出标题均与回答正文左对齐；移除详情侧边线，保留代码容器自身内边距。已展开的工具详情及代码滚动位置保留。正常完成后的“复制回复”只取适配规则选出的回答正文，不混入已折叠过程说明、思考或工具输出。手动展开状态在本次组件生命周期内保留，不新增持久 UI 状态或后端阶段字段。

### 参考行为逐项核对

初版只落实了整轮折叠和工具行，不能据此认定已对齐整个 Codex timeline。用户指出连续工具组、思考摘要缺失后，按上述源码继续追踪；以下对照区分参考行为、本批适配和实际证据。组件测试验证这些明确规则，不能代替视觉检查或用户确认。

| 核对项 | 本批实现与差异 | 验证入口及当前边界 |
| --- | --- | --- |
| 正文之间连续调用 | 多个相邻工具合为默认收起的一组，正文和可见思考块分隔组，空块不分隔；单个工具仍直接显示。Codex 会过滤普通 reasoning 后再分组，本批保留可展开的思考块，边界有此差异 | `ConsecutiveTools` 的调用方式与阶段控件、`ToolsWithResponse`；测试核对两组之间正文可见、组内实际顺序及当前调用／异常摘要 |
| 工具行与组标题 | 单条和活跃组共享动作／目标格式化，图标在前、箭头在内容尾部；结束组采用上述动作类别与固定顺序，图标对应首个类别，不逐个拼工具名 | 测试覆盖同名重复、混合探索工具、文件写入／编辑合类及调用顺序变化；浏览器核对 Read／Edit／Bash、探索组汇总、执行中标题和停止后的摘要切换 |
| 分组流式更新 | 从首个工具起保持组身份，后续新增工具、状态更新、整轮收起／展开不重置已展开工具；不展示分组或单工具耗时 | 测试覆盖单项增长为多项、失败计数、工具节点身份与整轮完成后的展开状态；浏览器展开两组后 Stop，组状态及已展开的 Glob 详情均保留 |
| 思考默认摘要 | 按用户所指，每个思考块默认显示末尾非空可见行，过滤注释并渲染 Markdown；最新思考流持续更新，点击查看完整原文。Codex 的末行用于当前状态提示，其他详情模式的正文预览／动画不在本批照搬 | `PausedAfterData` 的思考变体；测试覆盖 CRLF、空行、完整／未闭合注释、Markdown、更新及完成后展开状态 |
| 整轮过程／回答 | 产品按 Harness 最终 Gen 选出 response 块 ID，分离过程并允许空回答；不以文本位置或上游可选 phase 为前置 | Rust 测试覆盖工具后新 Gen、空最终回复及 Journal 重开；renderer／真实 typed Gateway／Panel 测试通过，实际 sol 窗口核对最终 Markdown 留在折叠过程外、原文复制及重开；空回复由可控测试验证 |
| 用户明确调整 | 展开的过程、工具组与工具详情均不缩进，与回答左对齐；整轮完成摘要仅显示总用时；思考、单工具及工具组不显示耗时 | 浏览器核对组标题、工具图标和详情标题的起点一致，360px 视口下均为 x=21；整轮摘要为“用时 3.2 秒 ›”，时间来自 Run 起止记录，缺失时用“查看过程”。这些调整优先于参考 App 样式 |
| 工具状态与流光 | 正常完成不显示视觉状态标签；执行中的名称／目标、分组摘要、思考末行及当前输出正文使用文字流光。失败／结果未知在名称旁提示，停止／未执行继续明确区分，不在最右侧单列状态 | 浏览器检查完成行可见文本不含“已完成”，失败标签与名称相距 6px；执行中动画时间持续增长，Stop／输出完成后为 0，减少动态效果时为 0 |
| 视觉与实际接线 | 用户确认调整后的预览并要求接产品，产品与 Storybook 现复用同一展示路径；未声称像素与 Codex 完全一致 | 360 像素视口无整体横向溢出，代码块聚焦后方向键横移已有实际位移证据；实际 Electron 窗口、系统剪贴板、停止／失败、Edit diff 和重开均已验收，重启前后历史及文件摘要相同，详见本批证据 |

正文与代码、思考、现有工具、消息复制、模型选择与发送／停止均已接产品；本轮 composer／hint 按用户要求跳过 Storybook，不重复规划。历史分页、问答／授权和压缩／继续状态仍按各片前置实施，复用现有组件并验收新增视觉。本期按已确认范围保留 textarea，不引入新的编辑器依赖。

## 可观测性与验证

复用现有日志机制，以会话、运行和调用 ID 关联模型调用、工具执行、授权、停止、持久化失败和最终结果；记录阶段与安全错误原因，不逐 token 打日志，不记录凭据或默认倾倒用户消息／工具参数。

自动验证分层覆盖 core 状态机、真实 typed Gateway 边界、storage 重启恢复和 UI 交互。关键用例包括交错内容块、多工具循环、开流前停止、工具中停止、授权迟到、worker 断流、renderer 重连、删除与迟到写入竞争，以及重试不会重复工具副作用。实际产品验收从 Quick Chat 入口完成，遵循仓库实例规则，不由 Agent 冷启动应用。
