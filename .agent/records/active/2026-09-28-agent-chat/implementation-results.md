# 交付结果与验证证据

所属事项：[Agent Chat](../2026-09-28-agent-chat.md)。本文只保留当前成果、关键迁移差异和验证结论；字段、接口与行为分别见[历史格式](history-format.md)、[架构](architecture.md)、[Host](host-interface.md)、[控制协议](control-api.md)及[运行与 UI](runtime-ui.md)。

## 工具循环与文件工具（2026-10-18）

02e 与第一批 Read／Write／Edit 已完成代码接入及核心链路验收，2026-10-19 补齐实际 Quick Chat 窗口验收。系统正文、实际文件工具、cwd 和基础写入权限共同进入生产路径，后续批次未提前开放。

- xw-agent 持有多 Turn 的顺序工具循环，runtime 收集单次合法完整生成并执行文件原语。每 Run 50 次工具调用，工具意图先提交、文件操作后执行，结果提交后才继续模型；非法参数／未知工具形成配对错误，截断调用不执行。
- 会话默认目录为 `<Agent root>/quick-chat/<session-id>/`；可指定已有外部 cwd，Header 持久化并稳定恢复。归档保留文件，删除仅清理自有目录；兼容无 cwd 的旧 v2 Header，不改写旧记录或回退进程 cwd。
- 文本 Read 支持行号、分页、缺失处理、输出上限和基于已提交读取的去重；Write 覆盖并创建父目录；Edit 精确唯一替换或显式 replace_all，写入结果保留有界 diff。PDF 暂不实现。
- 写权限按真实路径和 symlink 检查，保留 cwd／临时目录／有效授权及 home 边界；`.git` 不额外禁写。RequestPermission 尚未开放时，范围外操作返回权限不足。旧浏览器专用 `.bsk` 写入例外未迁移，等待相关能力接入。
- 公共工具 Item 含身份关联、枚举状态、参数、输出、metadata 与耗时，支持订阅和历史恢复；renderer 复用现有折叠详情展示。完整交错工具卡片仍属 03c，当前按 Run 汇总文字与思考，不宣称完整卡片已交付。
- 停止会等待已启动文件操作实际结算，再闭合未执行项，不启动后续生成；存储失败立即停止。工具结果未知时阻止普通新 Run，后续 Continue 实施前不自动重放副作用；删除中的会话不会被迟到 Run 结算恢复成 Idle。

正式模型验收使用新建临时 Agent 根目录，经实际 addon → Gateway → 构建后的 worker → 配置中的真实模型，依次执行 Write／Read／Edit／Read；四个结果成功、最终文件严格为 `hello\nxiaowei\n`，随后模型正常回复。测试文件为 `crates/xiaowei-agent/napi/test/tool-loop.test.cjs`；默认模式只 mock HTTP，仍经过真实 Pi provider 与文件工具。运行真实模型版本：`XIAOWEI_AGENT_LIVE=1 pnpm --dir crates/xiaowei-agent/napi exec node --conditions=source --import tsx --test test/tool-loop.test.cjs`。临时根目录自动清理，不操作现有用户文件。

核心测试另外覆盖多 Turn／工具结果进入后续请求、重开不重放、错误工具配对、50 次限制、批次停止、外部 cwd 删除保留、旧 Header 固定目录及结果提交失败后未知副作用保护。PB／领域 JSON 基线及增量往返、正式 provider 编码与拒绝不支持更新、renderer pending → completed／恢复快照投影均有回归。

系统上下文真实模型验收的五个场景已通过，工具新增保持原始基线和历史位置；工具删除／同名替换在当前正式适配入口明确拒绝，原因与后续边界见[正式生成接线](model-types.md#正式生成接线与适配边界2026-10-18)。未宣称其他 provider 的实际增量或缓存收益已验收；不以“变化通知加完整当前 tools”静默降级。

最终 153 项相关 Rust 测试、严格 no-deps Clippy、正式 Agent addon 构建、完整 desktop 回归（renderer 146 项，正式 Agent 链路 6 项）、契约 codec 测试及 just check 通过。另补跑正式 provider 的 5 项确定性回归，包含不支持的更新在 HTTP 前拒绝；真实配置 provider 的五场景验收通过。完整回归后仅补充 provider 拒绝门禁及等价排版，已通过对应回归和最终开发构建。

当前工作区已有开发实例通过 cmux 控制台重建并重启，确认 Electron 路径、cwd 和控制器父子关系属于本仓库。此前窗口连接的 timeoutReached／cgWindowNotFound 来自窗口隐藏状态下的取窗尝试；没有先确认快捷键成功唤起窗口就认定自动化受阻，属于验收操作判断错误。2026-10-19 使用 `⌘⇧C` 拉起 Quick Chat 后，按实际 Electron 路径调用原生自动化，立即取得窗口及可访问性树，无需修复或配置自动化服务。

实际产品验收创建独立测试会话 `01a1517a-ade1-762c-bff2-830741ece785`，从输入框发送文件任务：Write → Read → Edit → Read 四个折叠详情均显示已完成，展开最终 Read 得到带行号的 hello／xiaowei，最终回复报告同一 cwd 和内容。只读核对 Header cwd 为 `~/.xiaowei/quick-chat/<session-id>/`，`ui-02e-20261019.txt` 的字节严格等于 `hello\nxiaowei\n`；本 Run 共 5 次模型生成、4 对工具意图／结果、1 个 completed RunEnd。

随后从同一输入框发送仅反复 Read 的停止任务：首个 Read 已完成后点击实际停止按钮，界面显示已停止；已启动的后续生成结算 aborted，没有继续工具循环。通过当前 cmux 控制台重启已有实例，重新用快捷键拉起窗口，同一会话的四个成功工具详情、最终回复及停止任务恢复，展开最终 Read 仍显示相同两行。重启前后 JSONL 共 55 条，SHA-256 相同，文件字节未变，没有新增 Run、工具或恢复终态，证明该验收会话未自动重放。测试会话与文件保留供复核，未改动已有用户会话内容。

本批代码及约定验收已完成，删除 02e 临时计划；其他未交付工具和动态工具适配限制仍按既有 record／后续批次推进。此轮只补充产品验收与文档，未改业务代码、未提交。

## 持久文本聊天里程碑

截至 2026-10-07，xw-agent-types、xw-agent-rollout、xw-agent-runtime、xw-agent、xiaowei-agent 及正式 napi 已接入产品。Quick Chat 经 Agent typed RPC／SubscribeSession 使用同一 App Server，执行多轮文本／思考、停止及失败处理，显示缓存与模型历史分离。隐藏或关闭观察不停止 Run；新建等待当前 Run 结算但保留旧会话。

统一 AgentHost 提供生成、模型信息及辅助模型引用，wrapper 分别调用 Llm.Generate、Llm.GetModelInfo、ModelSettings.GetAuxiliaryModelRef。模型查询失败保持原引用并显示持续 hint，预算回退为 256_000／32_768。可观测的 SSE 路径记录首个完整 data event 的时间，非 SSE／不可注入路径保持未知。模型与思考选择独立持久提交，Run 保留自身快照；composer 外部右上方 chip 的位置和样式已按用户反馈修正并获确认。

会话目录由 xw-agent 自己管理 sessions.sqlite，宿主只传根目录；列表不扫描 JSONL。标题／自动生成开关、归档／删除状态和维护策略在 SQLite，模型配置及执行历史在 JSONL。已接会话列表、切换、重命名、归档／恢复、批量删除接口及设置归档页；归档页只提供单条删除，恢复只 toast。核心定时维护与查看保护已接入，策略保存成功后替换维护任务。Quick Chat 启动选择最后更新的未归档会话，不额外保存选中 ID。

JSONL 采用精简 v2：Header 只写一次，第二条 Meta 保存初始模型选择；后续不重复版本、会话 ID 或 sequence，RunStarted 内嵌必要 RunContext。codec 从验证过的前缀恢复冗余字段，保留响应来源、签名、原始 JSON、独立测量及单调耗时。文件层负责锁、提交与尾部修复，core 负责业务中断结算；写失败终止 Run，下次 query 校验必要尾部后才能继续。没有自动执行历史模型／工具或用户修复入口。

## 与旧版的关键差异

- 采用旧 Rust 路线，但模型调用适配当前 Pi／LLM 契约，不搬入旧 xw-llm；领域消息保留当前契约全部已知回放字段。PB 转换在 xiaowei-agent，types 不依赖外部业务协议。
- xw-agent 充当可嵌入的 App Server，使用 Agent proto 而不依赖 Gateway；请求／响应及直接业务事件参考 Codex App Server 的边界，不承诺 wire 兼容。不采用旧 cursor／ReadChanges 草案。
- SQLite 会话目录由核心自管，不接 Storage Gateway DAO；标题及管理状态不是可丢弃重建的索引缓存。只使用最终 session／meta 结构，不保留开发期中间表或运行时迁移。
- 首期输入仍为 textarea，没有附件／图片输入、富文本、Skills／命令资源或旧会话导入。Read／Write／Edit 已有实际执行能力，其他工具、交互和压缩仍待实施；不能宣称已全面迁移旧 Agent。
- 后续交互采用 pending Interaction、逐端 ACK 与唯一决定，同 Run 等待／恢复；旧版 stop_loop 后另开 Run 的方式不沿用。此设计尚未实施。

## 自动验证

| 层次 | 已完成的验证 |
| --- | --- |
| Rust 领域／文件／运行／服务／集成 | 最新 Header／Meta 调整后共 122 项通过；覆盖格式与合法前缀、引用／生命周期、写失败、跨进程锁、尾部修复、恢复不重复结算、模型查询失败、初始 Meta、SQLite 管理及任务生命周期 |
| 静态检查 | strict no-deps Clippy、just check 通过；契约 codec 和 Rust／TS／descriptor 生成一致性已验证 |
| 正式 napi／Gateway／worker | 当前 addon 重建后 5 项通过；包含实际 worker 生成、取消、多观察者、持久重开、标题只写 SQL、归档删除及维护策略 |
| Desktop 回归 | 此前完整回归通过，renderer 20 文件／139 项；覆盖启动恢复、会话隔离、模型选择、标题、列表、归档及设置交互。最新 Header 调整未重跑整套 desktop，仅运行相关原生边界及 just check |
| 会话维护 skill | 格式校验及 10 项临时数据用例通过；预览／确认、全工作区进程与数据库占用检查、清单变化、symlink、写锁及清理失败保护 |

2026-10-07 针对 CI runtime 取消用例返回 Failed 的问题，新增在流 poll 内触发取消的确定性回归：修复前 EOF 路径稳定结算 Failed，修复后 EOF、流错误、provider 失败及最终消息四种返回均结算 Cancelled，并保留先前部分显示、不生成成功历史。聊天 runtime 读取返回后复核 token；正式 napi 取消断言补充 run.error，便于后续 CI 诊断。受影响 Agent addon 已重建，runtime 5 项、正式 napi／worker 5 项、完整 just test、just check 及 runtime strict Clippy 通过，renderer 22 文件／145 项通过。此轮未配置 XIAOWEI_TEST_DATABASE_URL，Go PostgreSQL／认证集成测试未执行；修复后的 GitHub Actions 尚未重跑。

抢占／交互／压缩 fixture 通过只说明历史结构可验证，不证明对应产品能力已经实现。文件工具另有实际链路证据，见上文。

## 真实数据与运行实例

2026-10-07 工作区运行日志确认真实两轮对话及自动标题完成。对 session `01a1141c-f5ff-718b-9462-6169031702b2` 的数据副本，通过正式 Agent.open、ListSessions、ReadSession(include_runs=true)、SubscribeSession 连续两次关闭重开：2 个 Run、2 条用户消息和 2 条回复逐项一致，读取与首帧投影一致，没有改写文件或重复终态。

用户确认保留该会话并离线调整 Header；在所有工作区开发进程停止、SQLite 无连接占用后，只替换第一行，第二条完整 Meta 及其余记录字节、身份和 SQLite 行保持不变。最终文件为 22 条记录，SQLite quick_check=ok；源码不增加旧格式读取分支。

用户再次启动后，10:33:07 核对 Electron、监听器及控制器的绝对路径、cwd、祖先链和实际 native loader，确认属于当前工作区并加载当前 Agent addon。日志显示原会话 loaded、repaired_bytes=0，renderer 随后恢复同一最新会话；没有新建会话／Run，文件仍为 22 条、2 个 Run／RunEnd，启动段无 error／warn。

## 验收限制与后续工作

用户已确认 chip 样式，并将当前成果视为可提交里程碑。此前文本 MVP 的真实模型多轮、思考、停止后再发送、新对话和错误恢复经 Electron 验证。最新持久化的数据／正式调用入口及运行恢复已验证，但桌面控制工具报 `Sky Computer Use native pipe startup failed`，未直接确认窗口内容及全部菜单操作。

人工复验仍包括模型／思考选择重开及重启后的显示、会话归档页搜索／恢复／删除、维护设置保存与可见查看保护、系统剪贴板复制、原生拖动，以及从 Quick Chat 入口事项转入的搜索高亮闪动和首次设置跳转。保留这些限制，不把日志或自动测试写成全部视觉验收通过；不再为已实现能力保留重复的代码实施计划。

当前正文与思考只做纯文本展示，思考可折叠；Markdown 解析、代码块渲染及消息复制尚未实现，不能列为已交付 UI 能力。

剩余计划见[总实施顺序](../../../plans/2026-09-28-agent-chat/00-implementation-order.md)：Markdown／代码与历史分页 UI、大历史读取、其他基础工具／审批、自动压缩、显式继续、辅助标题 Gen 记录及对应 UI／完整产品验收。FollowUp／Steering／Preempt、rewind／fork、CLI 与手机 transport 仅保留已确认设计边界。
