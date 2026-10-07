# App Server 控制协议与客户端同步

> 当前文本控制已接入 JSONL 基础持久化；会话选择独立提交，重开可恢复文本 Run／Item。SQLite 列表分页、归档与删除已接入；历史分页、工具与交互仍是后续范围，实际宿主边界见 [Host](host-interface.md)。

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。本文是同一 record 的专题附件，状态与范围由主 record 管理。

本文区分已实现的持久文本控制协议与后续工具／交互设计。宿主创建／配置／依赖注入接口另见[宿主接口复核](host-interface.md)，不与客户端命令混用。

## 一套 App Server 协议，两种连接（待实施）

手机与桌面 UI 复用请求、响应、事件、交互回应的同一业务定义。桌面 UI 经本地 Gateway／IPC／napi 连接；手机经桌面宿主中的远程虚拟连接；两者最终进入 `xiaowei-agent/src/gateway.rs` 的同一 handler 和服务实例。允许未来纯 Rust 宿主以本地 typed 调用接入同一应用用例，不允许绕过 App Server 直接控制 runtime。

```text
桌面 UI ←→ 本地连接 ────────┐
                           ├←→ 同一 App Server 协议入口 ←→ 应用用例 ←→ Agent Core
手机 UI ←→ 远程虚拟连接 ────┘
           （终止于桌面宿主）
```

不再区分“远程命令接入”和“独立状态同步出口”两套业务模块。远程 adapter 在同一逻辑连接上转发 request／response、订阅／通知和交互回应；远程身份由宿主验证后建立调用上下文，不从业务 payload 自报。RPC 响应只回发起连接，公共变化发给所有有权订阅该会话的连接。逻辑请求键是 `(connection ID, RPC request ID)`；网络 hop 可以映射 RPC ID，但不能改写 input ID、其他业务幂等 ID 或其他业务身份。

业务请求／响应和状态事件复用公共契约，并不要求把命令响应与广播事件编码为同一种消息。响应表示该操作的结果；事件表示公共状态发生变化。请求被接纳、实际消费和整轮完成是不同阶段，状态以 App Server／Core 为准。网络已收到或已转发不等于 Agent 已接纳；断连不取消运行，也不自动拒绝待答交互。

首期复用现有 Protobuf + Gateway envelope；不引入第二套 JSON-RPC wire。这里对齐 Codex 的包责任、统一入口和状态所有权，**不承诺 Codex wire 兼容**。网络 frame、配对和版本协商后续设计；传输 adapter 必须支持同一业务方法／事件／错误语义，不能创建手机专属 Send／Queue 协议或转发任意内部 Gateway 能力。

## 客户端本地状态与后续排队／插入边界

客户端保留草稿、焦点、滚动、卡片展开与当前选中会话；缓存服务器快照和变化；另记录请求提交中、断连或结果未知。缓存和 pending 不拥有输入接纳、队列顺序、steering 生效、工具决定或运行终态。UI 可以先展示 pending 输入，再按 input ID 合并服务器回声，不能在服务器确认前标记为已排队或已生效。

发送路径为 pending → 服务端持久接纳并广播 Input → 消费并关联 Run → Item／模型与工具变化 → 终态。后续 follow-up 由服务确认队列顺序，消费时才关联新的 run；取消／重排也通过服务命令。steering 指定预期活动 run，服务接纳后仍可等待安全边界，实际消费时才发布 applied boundary；接纳不等于已影响模型。两端均观察相同 Input／Run／Item／Interaction 变化，而不是仅同步 LLM 文本。

首期仍只接纳普通发送，运行中发送明确冲突；queue／steer RPC、排队状态、手机 UI 与网络 adapter 不提前实现。未来功能扩展同一个 Input、JSONL 恢复和变化契约。重连重新订阅，以首帧完整快照替换缓存；不续传旧事件。公共持久状态可恢复，未进入业务层的传输失败只属于请求方，不伪造会话事件。

## 共享 Agent 控制 API

`xiaowei.agent.Agent` 是客户端控制协议。xw-agent 直接使用生成的 Request／Response／AgentEvent，独立于 Gateway；xiaowei-agent 已注册同名 unary／stream handler，使用 Llm／ModelSettings consumer，分别查询生成能力与辅助引用。会话目录由 xw-agent 内置 SQLite 管理，xiaowei-agent 只传目录，不存在存储 Gateway RPC 或注入 adapter。

当前 Rust 服务和 Gateway 都提供 CreateSession、ListSessions、ReadSession、SetSessionConfig、SetSessionTitle、SetSessionArchived、DeleteSession、SubscribeSession、TrackSessionViewing、StartRun、InterruptRun、RegenerateTitle 及 GetSessionRetentionPolicy／SetSessionRetentionPolicy。正式 napi 与 Quick Chat 已接通，Run／Item 事件由真实文本执行产生。

| 公共实体／方法 | 已定义的语义 |
| --- | --- |
| AgentSession | ID、model_ref／optional reasoning 配置、idle／running／deleted、时间、metadata revision、title／auto_title_enabled、可选完整 runs |
| AgentRun | 对应 Codex Turn；run／input ID、有效模型配置、状态、items、开始／结束时间与安全错误 |
| AgentItem | 稳定 item ID，oneof user_message／agent_message／reasoning；显示内容与模型回放分开 |
| CreateSession | client_request_id + 必填 config；仅在当前服务实例内幂等创建、同键不同原始配置冲突；重启后通过 session_id 重开会话，不从 SQLite 或 JSONL 恢复创建去重 |
| ListSessions | 返回不含运行历史的会话摘要，包含标题、自动生成开关、创建／更新时间、归档状态与 revision；archived 与标题 query 过滤、默认 50／最大 100、continuation 绑定两种过滤条件；菜单／设置页按需刷新 |
| ReadSession | session_id + include_runs；读取配置／状态及可选 Run／Item 快照；不暴露内部 journal |
| SetSessionTitle | session_id + title；trim 后 1～50 个 Unicode 字符且无控制字符，设 auto_title_enabled=false，取消旧标题任务并关闭自动生成；成功同时推进 updated_at_ms，响应确认 title／metadata_revision，同名且已关闭自动生成、无在途任务时幂等；不调用模型或停止 Run |
| DeleteSession | 非空 targets，每项 session_id + expected_metadata_revision + optional expected_archive_revision；后者存在时须仍归档；顺序结算／清理，返回逐项 Deleted／Skipped／Failed／NotExecuted，冲突跳过，实际错误停止，已删除不回滚 |
| SetSessionArchived | session_id + archived + expected_archive_revision；停止并结算后归档，归档后禁止打开／修改，取消归档才可恢复 |
| SetSessionConfig | config + expected_metadata_revision；独立提交会话选择并发布 SessionConfigUpdated |
| StartRun | session_id、input_id、有序结构化 input、可选完整 config；响应为原子接纳的 Run，不等待模型完成 |
| InterruptRun | session_id + run_id；响应只确认取消请求，终态从 RunCompleted 得到 |
| SubscribeSession | 必填 session_id，只订阅该会话，响应流首帧 SubscriptionReady 包含指定单个会话完整快照，随后只发送快照之后的业务事件；Rust 直接宿主消费同一个 EventSubscription |

RegenerateTitle 使用 Host 当次查询的辅助引用，旧 title_model_ref 字段已忽略，有限超时等待完整标题；成功设 auto_title_enabled=true 并恢复自动生成，失败保留原标题与开关。手动改名／主动重新生成推进 updated_at_ms，每轮后的自动标题生成保留原时间；结果均通过含提交后 updated_at_ms 的 SessionTitleUpdated 同步到所有观察者，快照和摘要也保存该开关；RPC 响应不覆盖事件缓存。

会话配置在创建时保存并返回。StartRun.config 缺失继承默认，存在时只覆盖当前 Run；SetSessionConfig 单独提交会话默认，reasoning 缺失表示模型默认。ModelSettings 和 provider 解析仍归调用方／LLM 层，Agent 不读取外部业务设置。业务 UUIDv7 身份与 Gateway 请求 ID 分开，可信来源单独由宿主提供，不由客户端 payload 自报。

### 请求、响应与直接业务事件

公共契约统一在 agent.proto；命令用独立 Request／Response，事件通过 AgentEvent.payload oneof 携带 SessionStarted／Deleted、RunStarted／Completed、ItemStarted／Completed、AgentMessageDelta／ReasoningDelta、SessionTitleUpdated。不再保留 SendMessage → AgentInputView、SessionChanged → ReadChanges 的主链路。Source、取消 token、trait 和内部执行事件不属于 PB；runtime 使用自己的生成请求／事件，由 xw-agent 转换。

StartRun 返回接纳的 Run，不等待模型。同 input ID／同原始请求复用原关联，不同请求冲突；运行中的新输入冲突。响应丢失先 ReadSession(include_runs) 按 input ID 查询，未找到或查询失败不表示旧请求必然失败，也不授权换新 ID 重发；客户端保留 pending 输入并阻止再次发送，直到事件确认或用户明确新建对话。取消只命中指定 Run，不能因迟到请求取消新 Run。RunCompleted 才表示结算，ItemCompleted 即使包含 partial 也不代表成功模型历史。

事件与命令响应可能交错，UI 按 Run／Input／Item 身份合并；服务控制权威状态，客户端保存显示缓存和 pending。首帧快照与观察者登记原子完成，先前 delta 不重复发送。RPC 响应不能用来覆盖活跃流状态，ReadSession 仅用于独立查询。观察者独立有界，超限明确失败并结束流，不能合并正文增量后继续使用不完整状态。

请求级错误通过核心 AgentError／SubscriptionError 和集成层 Gateway 错误通道表达。DeleteSession 是批量结果接口：格式错误（非法 ID／revision、重复目标、空列表）在任何删除前拒绝请求；单项目标的冲突／实际失败明确写入结果，RPC 返回不代表整批全部成功。当前普通输入拒绝不生成公共 InputView；后续排队／插入需要独立接纳和消费状态时再扩展同一事件协议。未来审批仍采用以下已确认的两阶段语义，不承诺 Codex wire 兼容。

会话维护策略与可见查看流的持久化、定时调度和取消规则见[设置归档管理](runtime-ui.md#设置归档管理)。TrackSessionViewing 不替代事件订阅、不修改消息历史；策略变更独立于模型 Host 注入，所有方法仍由 xiaowei-agent 的 Agent handler 适配 core。

### 两阶段交互与多客户端送达（已确认，待实施）

2026-10-03 用户明确“送达”是收到客户端回复，该回复只确认收到，不表达授权或拒绝。第一阶段完成不解决 Interaction，也不恢复工具执行；第二阶段才提交和接纳用户决定。多个客户端分别确认接收，但共享一个 Interaction 和唯一最终决定。

```text
服务端 → 桌面：投递审批 A，delivery D1
桌面 → 服务端：D1 已收到                     # A 仍 pending
服务端 → 手机：投递同一个 A，delivery D2
手机 → 服务端：D2 已收到                     # A 仍 pending

任一有权客户端 → 服务端：RespondInteraction(A, 授权／拒绝)
服务端 → 提交者：决定已接纳／冲突
服务端 → 所有观察者：A 已解决
```

当前 Gateway 的 Client 只提供 invoke／stream／subscribe，不支持注册 renderer owner 或服务端直接调用客户端 handler；事件 sink 完成也不是可传回服务的业务确认。实现复用现有 Gateway，而不改通信核心：客户端打开 `Agent.ObserveInteractions` 响应流，服务端逐客户端发送逻辑交互请求；客户端解码并放入本地交互缓存后，立即调用 `Agent.AcknowledgeInteraction` 返回接收确认。这里的确认 RPC 承载第一阶段的回复，不等待用户操作；`Agent.RespondInteraction` 独立承载第二阶段。所有消息仍在同一 `agent.proto` 和同一连接上，不新增手机专属协议。交互请求 stream 仅承担定向投递与接收跟踪，公共审批状态及其解决结果仍复用快照／直接业务事件，不再维护一份同步状态。

快照和公共事件 提供 observer 对应的送达状态；instance／observer／delivery 的投递请求关联经对应 stream 返回。设备显示名称后续由可信宿主提供，本期不让 caller 自报手机／桌面身份。

模块归属：`xw-agent/src/interactive.rs` 管理审批／问答业务状态、决定校验和持久化；`interaction_delivery.rs` 管理 observer、投递请求、接收事实及关闭；`xiaowei-agent/src/gateway.rs` 注册 stream 和两个 unary 方法。Gateway 管理 transport 请求／流关联，App Server 管理业务 delivery 与 Interaction。napi／main 只适配，renderer 页面适配层消费流并回复，展示组件不执行接收确认或业务 RPC。

| 身份／状态 | 规则 |
| --- | --- |
| interaction ID | 所有客户端共享，关联问题／权限和全局 pending／resolved／expired。来自 journal，接收确认不改变其业务 revision |
| observer ID | 服务生成，绑定可信 caller、session 和本次观察流；不是客户端自报设备身份。首次 ready frame 返回；同一客户端重连生成新 observer |
| delivery ID | 服务生成，属于 instance + observer + interaction，一条连接的回复不能确认另一条连接。重复确认同 delivery 幂等 |
| RPC／stream ID | Gateway 传输关联；不充当 interaction 或持久决定的身份。不能用一个收到首个回复便删除的共享 callback 代表所有端送达 |
| 单端送达状态 | 已登记但尚未发出 → 已发出、未确认 → 已确认收到；发送／入队／stream next 成功都不能代替确认。未确认不声称一定未送达 |
| 全局审批状态 | pending → resolved（含批准／拒绝）或 expired。任一有权客户端有效决定可解决，不需要所有端收到或共同批准 |

投递源在同一服务串行边界登记 observer 并读取现有 pending 交互，避免注册／创建竞态。每个客户端独立持有 stream、待确认请求与背压；一个慢端不会阻塞其他端或 Agent 结算。采用按当前待答交互生成的 pull source，不建立无限投递队列；相同 observer 对同一业务交互不重复生成新 delivery。新开流首先发送 ready，再补当前 pending；空闲时 20 秒 heartbeat，复用当前 Gateway 60 秒 producer／consumer idle 和 total_ms=0 的策略，不把用户处理耗时套进单个 unary RPC 超时。关闭／取消观察流只清理该 observer，不停止运行或拒绝审批。

客户端接收确认由流消费适配层自动发送，确认的是数据进入客户端缓存，不表示已经绘制或用户已读。确认失败可以重试同 delivery ID；提交决定可以先于接收确认到达，有效决定同时证明该 caller 收到交互，不能因回执丢失而拒绝。决定验证使用 Interaction 的业务 revision；另一个客户端的接收确认不能导致审批 revision 冲突。第一个通过校验并持久提交的决定被接纳，同一业务幂等 ID／相同决定重试返回原结果，其他竞争决定返回已解决／冲突。

Interaction 解决时广播公共状态，客户端关闭对应卡片；迟到投递或回执只能确认历史接收事实，不重新打开交互或执行工具。重连只补仍 pending 的请求，已解决交互通过快照／变化同步。流结束时旧 observer 不再活跃，旧 observer／服务实例的确认不得记到新观察流；服务在保留的投递记录上幂等处理迟到回执，记录已清理则返回明确过期结果。接收事实是当前实例的有界投递状态，不进入模型历史、不增加每端 JSONL 记录；服务重启清除投递状态并使遗留交互按既有恢复规则失效。稳定设备身份、离线设备清单与跨重启送达审计留到远程控制事项，本期用两个独立逻辑 caller 验证语义。

内部历史类型已明确 InputMode（Send／FollowUp／Steering／Preempt）、expected_run_id、按接纳 sequence 的 FIFO、消费 Run／Turn 和 boundary；公共 queue／steer 方法和状态仍等功能实际实现时加入。其来源、排序和消费由服务确认；不能只加 UI 标志。本期公共 API 只接纳普通发送，不提前生成后续 RPC 或空调度实现。

### 后续能力（未实现）

SQLite 列表及归档／取消归档／删除已扩展现有接口；归档后禁止打开／订阅／发送，先取消归档再打开。Fork／Rewind、ContinueRun、辅助标题 Gen 持久记录，以及 ObserveInteractions／AcknowledgeInteraction／RespondInteraction 随实际生产者加入。此处不保留另一套 SendMessage／GetInput／ReadChanges 空接口。历史分页需要按 Run／Item 结构复核，不能重新让实时事件依赖逐 token 拉取。

大历史分页由 01f 在现有 Run／Item 框架上扩展，不采用旧 GetMessages／ReadChanges 方案，不继续细拆。持久内容不能截断，读取需要明确有界；公共 snapshot／分页规则届时与存储实现一起确定。MVP 的 ReadSession 完整响应／订阅首帧受 1 MiB 编码预算约束，超额明确失败；没有增大通用上限或截断历史。

私有 SessionCatalog 只在核心内部使用；登记是 INSERT，更新只针对已有未删除行，并在服务串行边界按内存 metadata revision 校验，不通过 Upsert 复活记录。归档 revision 独立校验，普通更新不能重置归档状态。标题／自动生成开关、管理状态以 SQLite 为准，不将数据库视为可删除重建的缓存。


SQLite 字段及权威状态边界统一见[历史格式](history-format.md#会话索引归档与删除)。

## 当前会话投影与同步

投影沿用旧 Projector 的按身份更新思想，展示消息与模型回放分离。当前 execution／events 维护在途公共视图，recovery 重建历史视图；UI 投影不回写模型历史，不要求新增另一套 projection／changes 模块。

当前采用直接 AgentEvent 流，每订阅最多 64 帧／1 MiB 编码字节；超限返回 SubscriptionError::Lagged 并结束流，Gateway 集成映射 resource-exhausted。各观察者互不影响，关闭订阅不停止运行。会话、Run／Item 生命周期和文本／思考事件都有真实生产者。

订阅登记、初始快照与变更使用同一服务锁：SubscriptionReady 首帧包含指定 Session 的完整 Run／Item 状态，后续帧只包含快照之后的变化。客户端以首帧替换缓存，随后顺序应用事件；断连或 lag 时重新订阅，旧流的迟到回调用本地订阅代次隔离。没有公开 AgentViewCursor、instance ID 或事件 revision；metadata revision 仅用于当前服务实例内的元信息写操作校验，冷恢复从 1 开始；连接到重启服务后须获取新快照，不能复用旧待提交请求及版本。初始完整快照超过 1 MiB 时直接拒绝订阅，不截断内容或保留观察者。

### 单会话订阅范围

SubscribeSession.session_id 必填且须为 UUIDv7，只观察该会话。SubscriptionReady.session 为单个完整快照，成功订阅时必定存在；缺失／非法 ID 返回参数错误，未知／已删除会话返回 NotFound，不打开空流，也不占用观察者容量。调用顺序为 CreateSession → SubscribeSession(session_id) → 接收首帧 → StartRun。其他 Session 的事件不会混入该订阅。

删除与登记沿同一服务锁收敛：删除先发生则订阅失败，登记先发生则首帧仍含原状态，随后收到该 SessionDeleted。其他会话的创建与删除不改变本订阅；全会话观察不属于当前公共 API。

### 重新打开会话的显示历史

ReadSessionResponse.session.runs[].items[] 是完整已保留的 UI 投影，include_runs=true 时返回；false 只查询会话元信息。需要继续观察时直接 SubscribeSession，其首帧 session 始终包括该会话完整公共 runs／items，然后接后续事件。客户端按结构恢复显示，不重执行历史工具或重新调用模型，也不将 UI 投影当作下一轮模型上下文。

当前 App Server 已实现真实执行和投影写入；客户端断线自动尝试一次重订阅，用首帧替换显示缓存，失败可通过后续操作重新同步；不会无限重连或重发控制命令。该恢复已包含 Agent.open 的文本 JSONL 重建；应用重启后从会话列表选择目标并订阅首帧，Quick Chat 已自动恢复最后更新的未归档会话；历史分页仍未实现。
