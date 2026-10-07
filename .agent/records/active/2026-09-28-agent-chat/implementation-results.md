# 交付结果与验证证据

所属事项：[Agent Chat](../2026-09-28-agent-chat.md)。本文只保留当前成果、关键迁移差异和验证结论；字段、接口与行为分别见[历史格式](history-format.md)、[架构](architecture.md)、[Host](host-interface.md)、[控制协议](control-api.md)及[运行与 UI](runtime-ui.md)。

## 持久文本聊天里程碑

截至 2026-10-07，xw-agent-types、xw-agent-rollout、xw-agent-runtime、xw-agent、xiaowei-agent 及正式 napi 已接入产品。Quick Chat 经 Agent typed RPC／SubscribeSession 使用同一 App Server，执行多轮文本／思考、停止及失败处理，显示缓存与模型历史分离。隐藏或关闭观察不停止 Run；新建等待当前 Run 结算但保留旧会话。

统一 AgentHost 提供生成、模型信息及辅助模型引用，wrapper 分别调用 Llm.Generate、Llm.GetModelInfo、ModelSettings.GetAuxiliaryModelRef。模型查询失败保持原引用并显示持续 hint，预算回退为 256_000／32_768。可观测的 SSE 路径记录首个完整 data event 的时间，非 SSE／不可注入路径保持未知。模型与思考选择独立持久提交，Run 保留自身快照；composer 外部右上方 chip 的位置和样式已按用户反馈修正并获确认。

会话目录由 xw-agent 自己管理 sessions.sqlite，宿主只传根目录；列表不扫描 JSONL。标题／自动生成开关、归档／删除状态和维护策略在 SQLite，模型配置及执行历史在 JSONL。已接会话列表、切换、重命名、归档／恢复、批量删除接口及设置归档页；归档页只提供单条删除，恢复只 toast。核心定时维护与查看保护已接入，策略保存成功后替换维护任务。Quick Chat 启动选择最后更新的未归档会话，不额外保存选中 ID。

JSONL 采用精简 v2：Header 只写一次，第二条 Meta 保存初始模型选择；后续不重复版本、会话 ID 或 sequence，RunStarted 内嵌必要 RunContext。codec 从验证过的前缀恢复冗余字段，保留响应来源、签名、原始 JSON、独立测量及单调耗时。文件层负责锁、提交与尾部修复，core 负责业务中断结算；写失败终止 Run，下次 query 校验必要尾部后才能继续。没有自动执行历史模型／工具或用户修复入口。

## 与旧版的关键差异

- 采用旧 Rust 路线，但模型调用适配当前 Pi／LLM 契约，不搬入旧 xw-llm；领域消息保留当前契约全部已知回放字段。PB 转换在 xiaowei-agent，types 不依赖外部业务协议。
- xw-agent 充当可嵌入的 App Server，使用 Agent proto 而不依赖 Gateway；请求／响应及直接业务事件参考 Codex App Server 的边界，不承诺 wire 兼容。不采用旧 cursor／ReadChanges 草案。
- SQLite 会话目录由核心自管，不接 Storage Gateway DAO；标题及管理状态不是可丢弃重建的索引缓存。只使用最终 session／meta 结构，不保留开发期中间表或运行时迁移。
- 首期输入仍为 textarea，没有附件／图片输入、富文本、Skills／命令资源或旧会话导入。工具、交互和压缩只有领域结构／fixture 验证，尚无实际执行能力；不能宣称已全面迁移旧 Agent。
- 后续交互采用 pending Interaction、逐端 ACK 与唯一决定，同 Run 等待／恢复；旧版 stop_loop 后另开 Run 的方式不沿用。此设计尚未实施。

## 自动验证

| 层次 | 已完成的验证 |
| --- | --- |
| Rust 领域／文件／运行／服务／集成 | 最新 Header／Meta 调整后共 122 项通过；覆盖格式与合法前缀、引用／生命周期、写失败、跨进程锁、尾部修复、恢复不重复结算、模型查询失败、初始 Meta、SQLite 管理及任务生命周期 |
| 静态检查 | strict no-deps Clippy、just check 通过；契约 codec 和 Rust／TS／descriptor 生成一致性已验证 |
| 正式 napi／Gateway／worker | 当前 addon 重建后 5 项通过；包含实际 worker 生成、取消、多观察者、持久重开、标题只写 SQL、归档删除及维护策略 |
| Desktop 回归 | 此前完整回归通过，renderer 20 文件／139 项；覆盖启动恢复、会话隔离、模型选择、标题、列表、归档及设置交互。最新 Header 调整未重跑整套 desktop，仅运行相关原生边界及 just check |
| 会话维护 skill | 格式校验及 10 项临时数据用例通过；预览／确认、全工作区进程与数据库占用检查、清单变化、symlink、写锁及清理失败保护 |

工具／抢占／交互／压缩 fixture 通过只说明历史结构可验证，不证明对应产品能力已经实现。

## 真实数据与运行实例

2026-10-07 工作区运行日志确认真实两轮对话及自动标题完成。对 session `01a1141c-f5ff-718b-9462-6169031702b2` 的数据副本，通过正式 Agent.open、ListSessions、ReadSession(include_runs=true)、SubscribeSession 连续两次关闭重开：2 个 Run、2 条用户消息和 2 条回复逐项一致，读取与首帧投影一致，没有改写文件或重复终态。

用户确认保留该会话并离线调整 Header；在所有工作区开发进程停止、SQLite 无连接占用后，只替换第一行，第二条完整 Meta 及其余记录字节、身份和 SQLite 行保持不变。最终文件为 22 条记录，SQLite quick_check=ok；源码不增加旧格式读取分支。

用户再次启动后，10:33:07 核对 Electron、监听器及控制器的绝对路径、cwd、祖先链和实际 native loader，确认属于当前工作区并加载当前 Agent addon。日志显示原会话 loaded、repaired_bytes=0，renderer 随后恢复同一最新会话；没有新建会话／Run，文件仍为 22 条、2 个 Run／RunEnd，启动段无 error／warn。

## 验收限制与后续工作

用户已确认 chip 样式，并将当前成果视为可提交里程碑。此前文本 MVP 的真实模型多轮、思考、停止后再发送、新对话和错误恢复经 Electron 验证。最新持久化的数据／正式调用入口及运行恢复已验证，但桌面控制工具报 `Sky Computer Use native pipe startup failed`，未直接确认窗口内容及全部菜单操作。

人工复验仍包括模型／思考选择重开及重启后的显示、会话归档页搜索／恢复／删除、维护设置保存与可见查看保护、系统剪贴板复制和原生拖动。保留这些限制，不把日志或自动测试写成全部视觉验收通过；不再为已实现能力保留重复的代码实施计划。

当前正文与思考只做纯文本展示，思考可折叠；Markdown 解析、代码块渲染及消息复制尚未实现，不能列为已交付 UI 能力。

剩余计划见[总实施顺序](../../../plans/2026-09-28-agent-chat/00-implementation-order.md)：Markdown／代码与历史分页 UI、大历史读取、工具循环／审批与真实基础工具、自动压缩、显式继续、辅助标题 Gen 记录及对应 UI／完整产品验收。FollowUp／Steering／Preempt、rewind／fork、CLI 与手机 transport 仅保留已确认设计边界。
