# 交付结果与验证证据

所属事项：[Agent Chat](../2026-09-28-agent-chat.md)。本文只保留当前成果、关键迁移差异和验证结论；字段、接口与行为分别见[历史格式](history-format.md)、[架构](architecture.md)、[Host](host-interface.md)、[控制协议](control-api.md)及[运行与 UI](runtime-ui.md)。

## TodoWrite 与清单卡片（2026-10-27）

第 5 批已实现 TodoWrite、对应工具规则、完整结果持久化和独立只读清单卡片。旧版源码依据、保留行为及恢复适配见[运行与 UI](runtime-ui.md#todowrite第-5-批)。沿用当前 run_loop、ToolOutcome 和正式 Gateway／napi／worker，无新增 RPC、表或 todo 文件。旧会话只追加 TodoWrite 声明和 tool.TodoWrite 规则，原基线及已有 schema 不改写。

验证结果：

- `cargo test -p xw-agent -p xw-agent-runtime --locked` 全部通过；补充的 Todo 定向回归通过。覆盖替换／按 ID 合并、四状态、多项进行中警告、非法参数不覆盖、完整结果进入后续模型、跨 Run／会话隔离、清空后恢复、重启不重放、未提交结果取消、Stop 跳过，以及旧会话只追加一次声明／规则且原前缀不变。
- 意图／结果提交部分写盘失败注入通过：失败更新不发布成功清单、不开始下一次生成、不重放；有意图但无结果时恢复取消并允许后续 Run。意图提交前失败保留既有未闭合调用保护，没有扩展 Continue。
- `pnpm --filter xiaowei-agent build:debug`、desktop build 和正式 addon／Gateway／worker 的全部 10 项测试通过；新增 TodoWrite → TodoWrite merge → Write → Read 场景核对完整清单与继续生成。
- 相同正式场景以当前实际模型单独验收通过，严格完成两次 TodoWrite 及 Write／Read，正常结束；renderer 全部 27 文件／211 项通过，覆盖四状态、合并后完整清单、独立卡片、最新默认展开、手动折叠保持、空列表及错误回退。
- `just check` 及 Agent／runtime strict no-deps Clippy 通过。没有修改业务契约或生成产物。

产品验收通过同一工作区 cmux console 的 r 重建加载；inspect 确认来源、cwd 及当前实例属于本仓库。实际 tctony/sol 在独立验收会话 `01a17c7d-70be-75a4-90d3-c864388d40f4` 完成两次 TodoWrite，窗口确认独立卡片、状态图标、合并后保留未传任务、完成文字弱化及取消删除线。未向已有用户会话追加任务。

随后经同一 console 重启，Electron 从 6692 变为 28024，实例从 `9425a4d5-4aed-475c-b071-9124622baa5d` 变为 `9f8334cd-eef4-46df-85a4-92496c257a3d`。原会话恢复后，JSONL 仍为 26 条／25157 字节，SHA-256 同为 `edd922b7ea7ce36691df429c05ad3d8ebd4ac8bef159903a1cc749e022b0f680`，没有新增生成或工具重放；展开过程后，旧卡片收起，最新清单默认展开，四项状态与重启前一致。明确发送新一轮，仅 merge 更新 b 后，实际窗口显示原四项全部保留、b 已完成，并回复“重启续写验收通过”。本批实现与约定验收完成，下一批为 WebFetch；原有平台及其他 provider 验收边界保持。

## 问答、权限与对应 UI（2026-10-26）

第 4 批已实现 AskUserQuestion／RequestPermission、逐端接收确认、唯一持久决定、同 Run 继续及实际 Quick Chat 卡片。问题支持单选／多选／自由文字，卡片与 composer 共用草稿和提交锁；权限决定只包含 allow，目标取已保存请求，批准后立即更新本 Run 的 FileTools 与后续 Bash。当前行为和旧版适配统一见[运行与 UI](runtime-ui.md#问答与权限卡片第-4-批)、[控制协议](control-api.md#两阶段交互与多客户端送达)和包内 README。本批功能链路、停止／恢复及明暗主题已验收；02f 已删除，03c 只保留依赖 01f 的完整工具长输出。真实输入法组合输入的完整平台复核继续留在 04d，不把合成事件当作真实输入法证据。

自动与正式链路检查已通过：

- `cargo test -p xw-agent -p xw-agent-runtime -p xw-agent-rollout --locked`；新增交互参数、重复选项索引、symlink／目标类型、独立 caller 回执、决定先于 ACK、重复决定与竞争、同 Run 继续、停止失效及真实范围外授权／拒绝。批准后同批 Write、后续 Edit／Bash 和持久重开均实际执行，旁边未授权文件不写入。
- 写盘失败注入证明失败决定不授予权限、不开始下一 Gen；当前卡片和修复／重开投影失效。实际新 Journal 的 Opened／Resolved 前缀恢复为取消或已提交回答结果，外部工具未知副作用保护保持。
- 原停止批次用例依赖 400 KB Write 的执行速度，完整回归暴露竞态；已改为在真实交互等待点停止，再核对未启动 Write 无副作用及全部工具结果闭合，未修改产品调度。
- `pnpm gateway:test` 和 `pnpm --dir desktop test`，后者包含实际桌面构建、LLM、正式 addon／worker 的 9 项、业务原生集成。最新 renderer 为 26 文件／207 项，覆盖 typed Gateway → hook → 产品 Panel 的双入口、草稿恢复、拒绝、断流同步、防重与未确认决定只重试原 ID／原答案。
- `just check`、`pnpm contracts:test` 及 Agent／runtime／集成包 strict no-deps Clippy。额外 Gateway strict Clippy 有 4 处本批未改文件的既有 `collapsible_if` 告警（event.rs／invoke.rs）；仅允许该 lint 后，含 napi 的 Gateway Clippy 通过。正式两个 addon 均已构建。

正式双 caller 联调暴露并修复 napi caller 身份与临时 transport token 混用：业务现使用宿主已有逻辑 caller，路由／取消仍保留原 token，权限来源不变；测试核对跨 caller ACK 被拒绝、正确 ACK、迟到 ACK 及决定竞争。送达打开、首次接收和关闭使用安全身份 debug 日志，不记录问题／答案正文或路径，也不逐心跳刷日志。

窗口验收使用当前工作区 console 的 r 重建；Electron 从 15359 变为 23961，inspect 实例为 `40c69ee4-0923-4035-aa18-f3f238e377a4`，cwd／父子链仍属于本仓库。以实际 sol 模型新建独立会话 `01a173d3-bcd7-76a5-9749-91f124136ac2`，未向旧验收会话追加。已通过实际窗口验证：单选点击即提交并显示回答摘要；连续多选卡片保持可见；选择文件／恢复后，从卡片填写文字、在 composer 补第二行，两个入口双向同步；Shift+Enter 换行、Enter 提交后继续原 Run；等待用户时无模型流光或等待模型标签。

00:10:55 的 Enter 已持久提交第二个回答；随后 macOS 前台变为锁屏进程 loginwindow，CUA 返回 cgWindowNotFound。inspect 仍确认同一实例、可见窗口与正常运行；未冷启动或改连其他工作区。只读 SQLite／JSONL 核对为 1 次 InputAccepted／RunStarted、3 次 Gen、3 个 Opened、2 个 Resolved／ToolOutcome，两个回应的可信来源均为 `frame:1:1`，无额外普通输入。当时停在第三个“请填写验收备注”，隔离 approved／denied 目录仍为空；以下为用户解锁后续验及 Agent 补验结果。

07:42 至 07:43 用户在同一会话手动续验：自由文字回答“好的”；批准 approved 目录后，在原 Run 中 Write／Read 完成，持久参数和读取结果严格为 `interaction-ui-ok\n`（末尾字节为 10）。首轮 denied 目录实际也被批准，用户随后另起一轮“重新验证denied”，提交 allow=false，模型收到拒绝结果后正常结束，没有写入或重复请求。后一次拒绝不撤销先前有效批准，不能将此样本当作“该目录当前没有权限”的证据；范围外拒绝后 Write 失败的验证使用前述隔离核心测试。最终为 2 个 Run／10 个 Gen、8 对工具意图／结果和 6 个已解决交互，两个 Run 均 Completed。当前原隔离目录已不存在，文件结果以当时的持久 Write／Read 记录为据，未重建目录或补写文件。

Agent 新建补验会话 `01a17574-57b8-774f-9763-5d2ad7fab0bb`，没有向用户手动验收会话追加任务。实际窗口确认等待问题时 Stop 使卡片失效、恢复普通聊天草稿，未提交的交互回答没有进入模型历史；再从问题卡片提交中文纯文字，保持同 Run 继续。随后在第二个真实待答问题处通过同一 console 的 r 重建并重启，加载最新 Agent addon：Electron 从 23961 变为 47648，inspect 实例变为 `4e78891b-414a-4d13-80cf-e1e801eeb21f`，cwd／父子链仍属于本仓库。窗口显示“重启后已失效”，没有遗留可操作按钮；恢复仅追加 InteractionExpired(recovery)、Cancelled 工具结果、TurnEnded 和 RunEnd 共 4 条，没有新增 Gen／工具意图。随后明确发送新一轮，模型正常回复“重启恢复验收通过”，未重放旧问题。

用户手动验收会话在上述重启前后 SQLite 行与 JSONL 完全一致：89 条／52517 字节，SHA-256 为 `3e99d05eb76bf6bf85cedde7f0b780128835e9adafa92957724e90d50fd625e5`。补验会话重启前为 34 条／29032 字节，恢复后 38 条／30035 字节；在显式新一轮前 Gen／ToolIntent 数量未变。深色主题下另请求从未批准的 `/Users/changtang/.xiaowei-interaction-reject-20261026-new/never.txt` 文件权限，完整路径、文件范围、理由及按钮可读，拒绝后正常显示只读决定并回复“已拒绝，未写入”，该目录未创建。当前补验会话为 4 Run／6 Gen、4 对工具意图／结果，65 条／49262 字节，SHA-256 为 `54982d516b673847021fa13a82ca0572a78411c009805c888876c7a6bbb130e7`。

明暗主题均在实际窗口检查，结束后恢复原浅色设置并切回用户手动验收会话。当前 Launcher 固定宽 800px 且不可调整大小，本批按该真实视口验收，不将浏览器窄屏当作支持的原生窗口形态。真实输入法尝试未取得组合态证据，不能声称已通过真实 IME；现有 Enter／Shift+Enter 与合成组合输入保护已通过，平台人工复核随 04d 保留。

## 有序消息与现有工具 UI（2026-10-25，产品接入与验收）

用户要求在问答／权限工具前，联合实施 03a 的 Markdown／代码／复制和 03c 的现有工具 UI；经本机 Codex app.asar 参考、Storybook 调整和用户确认后，已接实际 Quick Chat。Panel 直接复用 AgentMessage，旧的 Run 正文／思考／工具聚合字段与 renderMessageContent 预览分派已删除。显示规则和参考差异统一维护在 [运行与 UI](runtime-ui.md#codex-桌面参考与本批适配2026-10-25)，当前桌面行为见 [Quick Chat](../../../../desktop/docs/quick-chat.md)。

Harness 将当前 Generate 的身份、开始时间、内容接收状态及活跃 Item 纳入公开快照／有序事件；响应 Item 关联 Gen，正常终态明确最终无工具 response。空最终回复保留为空，不挪用先前说明。终态关联从既有 Journal 重建，不新增存储格式、provider phase 或传输层机制。3 秒首次等待、收到内容后停顿、工具后新 Gen 和终态分别使用真实生命周期；首 SSE／控制事件不算内容，工具声明不提前变成执行中工具 Item。

自动验证通过：`just check`、`pnpm contracts:test`、`pnpm --dir desktop test`、Storybook 构建，以及 xw-agent／runtime 的 112 项测试和 Clippy。renderer 为 25 文件／198 项；正式 Agent 原生模块 → Gateway → worker → Pi provider 的 8 项回归通过，并补断言核对新生成状态、Item 归属与终态字段跨边界传递。原生包已构建；这些 fixture 检查与下述实际 sol 验收分别计入。核心新增测试覆盖工具后新 Gen、原子快照重连、空最终回复与持久重开；renderer／真实 typed Gateway → hook → Panel 测试核对只复制最终 Markdown。

浏览器复用现有 Chrome 的本任务标签，检查已确认的明暗／窄屏、工具标题与展开对齐。360px 下 document 不横向溢出，代码容器支持内部滚动；激活本任务标签并聚焦代码块后，真实方向键使 scrollLeft 从 0 增至 15.5，焦点保持在代码块。此前工具动画、3 秒边界、减少动态效果和空／空白最终回复的检查仍有效；不将后台标签暂停动画判作产品失败。

用户启动当前工作区后，按 manage-dev-instances／inspect-running-app 核对控制器、cwd、父子链和 console，inspect 身份确认为本仓库，初始 Electron PID 8681。以实际 sol 模型新建独立验收会话 `01a17394-c7e2-73b9-a142-2e7e0a164a05`，未向旧测试或用户会话追加任务；通过实际输入框完成：

- 两次 Write → Glob → Grep → Read，共 6 次 Generate。正文将两个写入和后续搜索分开，形成“修改文件”和“读取文件”两组；跨 Gen 无正文的调用仍成组。执行中的展开选择在正常结束后保持；最终 Markdown 标题、表格和 JSON 代码留在外面，整轮折叠入口只显示“用时 23.2 秒”。工具图标在左、箭头在尾，展开后的工具和参数／输出标题不缩进，正常完成没有额外状态标签。
- 实际点击“复制回复”，再粘贴到输入框，得到原始 Markdown，未混入过程说明、思考或工具结果；“复制代码”粘贴得到 JSON 正文。复制后清空草稿，没有发送这些粘贴内容。相对时间位于复制按钮右侧并按分钟刷新。
- 前台 Bash 执行时点击实际 Stop，UI 显示停止，日志与结果确认为 Cancelled／Interrupted，没有继续生成。工具结果保留已输出的 `ui-streaming-pending`，未执行末尾输出。
- Read 一个不存在的本轮路径，工具显示紧邻格式化文件名的“失败”，正常最终回复报告真实错误；缺失文件未被创建，模型没有重试。

随后经已确认的 cmux console 按 r 重建并重启：Electron 由 8681 变为 15359，inspect 实例由 `d979ff33-97c2-4727-bcc6-e980cf628c9b` 变为 `be5d4414-190b-497a-8e7c-8d15eae39daa`，仍属于本工作区。日志 loaded／repaired_bytes=0，实际窗口恢复相同标题、三轮正文／停止／失败、最终回复和过程边界。重启前后新会话的 SQLite 行、两份文件及 JSONL 74 条／47476 字节完全相同，SHA-256 为 `e082e7379189aa39b8773a5e19b6c6055f327e5d221fb102a193013682046ad7`；无新增生成、工具或恢复记录。旧测试会话仍为 142 条／82314 字节，摘要 `8ef7a4f5d3eebe01bec445dea5a9e398018e59e56ac7bb8064327af08c47dd4e` 未变，SQLite 行也未变。

重启后继续补验 Edit → Read：只把本轮 config.json 的 timeout 从 30 改为 31，UI 混合组摘要为“修改文件、读取文件”，Edit 详情实际展示 +1／−1 diff。最后该会话为 4 Run、12 Gen、9 对工具意图／结果，JSONL 97 条／60345 字节，SHA-256 `3c46021be614f4c6f7b42be46e0bfc76a754c8ecbdea96a16b9940233e747ace`；此前三轮前缀摘要仍相同。config.json 最终严格为 `{"timeout":31,"retries":3}\n`，27 字节；README.md 为 `timeline-ui-check\n`，18 字节；missing.txt 不存在。保留独立验收会话和文件供复核。

本批展示与接线已完成，不宣称完整 Agent Chat 或两份 Plan 全部完成。大历史分页／完整长内容读取继续依赖 01f，AskUserQuestion／RequestPermission UI 继续依赖 02f；03a／03c 保留这些剩余范围。空最终 response 和精确 3 秒边界以可控自动测试验证，不声称实际 sol 返回过空回答；其他 provider 联调与真实输入法等原有边界不因本批扩大。

## Glob 与 Grep 文件搜索（2026-10-25）

第 3 批 Glob／Grep 已完成实现、自动检查、正式链路与 Quick Chat 真实模型验收。当前行为与接口维护在 [runtime](../../../../crates/xw-agent-runtime/README.md) 和 [core](../../../../crates/xw-agent/README.md)；02g Plan 已删除，下一批为 AskUserQuestion／RequestPermission。

迁移依据为 `xiaowei-next` HEAD `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3` 的 filesystem/file.rs、runtime Cargo.toml 及生产 filesystem bundle，核对时无未提交改动。沿用 globset／walkdir 与 grep-regex／grep-searcher／ignore，没有改成 shell 命令或另一套搜索实现。搜索集中放在现有 filesystem.rs 的子模块 search.rs，FileTools 复用 cwd／路径解析和 ToolOutput，core 仍持有原工具循环及提交边界。

保留旧版两种搜索的差异，包括 Glob 的递归补前缀、隐藏字面量例外、固定目录排除、mtime 排序及最新 500 项；Grep 的忽略规则、类型筛选、显式单文件行为及 5000 匹配行限制。实际验证确认 include 类型白名单可以放行匹配的隐藏文件，但不会覆盖 gitignore，未把它改成 Glob 的过滤策略。include 仍按旧版文件类型解释，不扩展为任意路径 glob。

本批适配增加 64 KiB 文本输出预算和 UTF-8 安全截断；旧版忽略的遍历／读取错误仍跳过，但现在通过正文、metadata 和安全计数日志说明结果可能不完整。Grep 到数量／字节上限后结束读取；流式 reader 在没有正则匹配时也能响应取消。core 将 Run token 传给搜索，等待阻塞操作退出后提交 Cancelled，再将未开始调用结算为 Skipped；不新增调度、存储或授权通道。Read／Write／Edit 的已有 schema 和执行语义不变。

验证：

- `cargo test -p xw-agent -p xw-agent-runtime --locked` 共 109 项通过。覆盖真实临时目录、隐藏／忽略规则、include、mtime 最新 500 项、无匹配、非法参数／模式、中文长行及大量输出、symlink／cwd 外只读、真实文件搜索取消、结果进入后续 Read／生成、重开不执行和旧会话增量升级。补充错误计数提示和规则后复验 runtime 的 lib／filesystem 及 core prompts；最终等价排序调整后复验 mtime 用例。
- runtime／core／集成层／正式 napi 的 all-targets、no-deps 严格 Clippy 通过。正式 Agent addon `build:debug`、desktop 生产 worker／bundle 构建通过；`pnpm --filter xiaowei-agent test:runtime` 8 项通过，扩展原 fixture 的 Write → Glob → Grep → Read 场景，检查真实工具输出、metadata 和进入后续 Pi 请求的结果。
- 当前工作区通过 cmux console 的 r 重建并加载最新原生模块；原生重建结束后串行运行 `just check` 通过。手写代码显示宽度与 diff 空白检查通过。未改 LLM 适配、PB 或 renderer 实现，不将上一批 renderer／LLM 测试数量重复计入本批。

窗口验收复用本 Agent 创建的测试会话 `01a17289-afc2-740c-b87b-a347f01c1b07`，模型为实际配置中的 sol。原有 Bash 验收的 60 条／39479 字节前缀 SHA-256 仍为 `34392f51a1a00429b6d5cbbb924b44804b86e8bcd83832b447bfc3cb449594a4`，没有改写。只追加一条包含 Glob／Grep 和 tool.Glob／tool.Grep 的系统增量，没有重复 base、Bash 或已有文件工具定义，随后第二个 Run 也没有重复同步。

通过实际输入框依次执行两次 Write → Glob → Grep → Read，五个工具均显示已完成。展开 Glob 得到唯一 notes.txt 路径，展开 Grep 得到 `notes.txt:2:search-needle-20261025`，Read 与正常回复确认三行内容。新增文件位于该会话 cwd 的 `ui-search-20261025/`；notes.txt 严格为 `alpha\nsearch-needle-20261025\nomega\n`，35 字节，SHA-256 为 `b271662f9e6934ef548f770042ac1581afc7e109658efc46eb6eb38f15a38d29`，另一个 unrelated.md 为 12 字节。没有调用 Bash 或修改其他文件。

第二个窗口任务依次执行无匹配 Glob、无匹配 Grep、非法 `[` Glob 和非法 `(` Grep。前两个工具显示已完成并返回 No files／No matches；后两个显示失败，持久结果分别为 Invalid glob pattern／Invalid regex。模型正确区分无匹配与非法模式，没有重试或扩大范围。执行中搜索取消由上述真实文件 Rust 集成测试覆盖，本次窗口验收没有用模型生成阶段的停止冒充搜索执行中的停止。

再次核对控制器、cwd、完整父子链、stdin 与 cmux console 后发送 r。Electron 从 `47526` 更换为 `55552`，inspect 实例 ID 从 `98faeb79-17db-4581-afeb-3c4cc2d08866` 更换为 `33ffb2c1-3431-47c3-86d7-1f4659b927e1`，仍属于当前工作区；日志确认同一会话 loaded、`repaired_bytes=0`。通过 inspect 显示窗口并核对实际截图，同一会话标题、工具终态和错误分类回复正确恢复。

重启前后 JSONL 均为 142 条／82314 字节，SHA-256 同为 `8ef7a4f5d3eebe01bec445dea5a9e398018e59e56ac7bb8064327af08c47dd4e`，共 5 个 Run、18 次生成、14 对工具意图／结果和两条系统记录。SQLite 会话行及该测试 cwd 的六个文件摘要完全相同，没有新增记录、自动搜索或重放；新增搜索验收共两个 Run、九次工具调用。保留测试会话与文件供复核，未操作已有用户任务。

## 前台 Bash 与 macOS 沙箱（2026-10-25）

第 2 批前台 Bash 已完成代码接入、自动／真实模型验证及 Quick Chat 产品窗口验收。02h 第一阶段实施与验收步骤已移除，后台工具仍保持第 7 批。实现入口和完整行为分别见 [runtime](../../../../crates/xw-agent-runtime/README.md)、[core](../../../../crates/xw-agent/README.md) 和 [Seatbelt 包](../../../../crates/xw-sandboxed-exec/README.md)，不在 record 重复维护 API 说明。

迁移前在 `~/Develop/XiaoWei/workspace/src/xiaowei-next` 核实旧仓库 HEAD 为 `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3`，相关文件没有未提交改动。已完整核对 Bash 的 mod／sandbox／session、sandboxed-exec 的 policy／seatbelt、两个 SBPL 和 Cargo.toml；旧包声明 MIT，没有发现独立许可证文件。迁入的新包按当前命名为 xw-sandboxed-exec，仅生成策略和命令参数，异步执行、取消和进程所有权仍归 runtime。Cargo workspace 已用 `crates/xw-*` 纳入新包，不重复增加显式 member。

- 保留旧写入限制、读取／网络开放、继承宿主环境、关闭 stdin、30 秒默认超时及 100 毫秒至 600 秒范围、双流各 32 KiB 捕获和 30000 字符输出限制；超限后继续排空。正文和 metadata 均能表明截断，metadata 字节数记录实际读到的总量。
- 不迁移旧后台参数、自动转后台、无沙箱分支或非 macOS 裸 shell 回退；其他平台不注册 Bash。按用户决定忽略 `.bsk` 专用例外，该路径仍服从普通 cwd／临时目录／有效授权规则。补充命令拦截不作为权限边界。
- 文件工具和 Bash 共享解析后的可写路径；将旧 extra_paths 一律 subpath 的行为收敛为精确文件／目录授权，避免单文件授权扩大。cwd 为 home 或祖先时不自动授权整棵目录；symlink 不扩大范围。
- 沿用 core 的意图先提交、执行后提交结果、结果落盘后继续模型。普通非零退出保留真实 exit_code 并视为已完成，参数／启动失败、检测到沙箱拒绝和超时为失败，停止为 Cancelled；未开始调用为 Skipped。回收／输出状态无法确认时保留未结算意图及 ResultUnknown，停止生成并阻止自动重放。
- Bash 使用独立进程组：SIGTERM 后等待 500 毫秒，先回收已退出 shell，再 SIGKILL；确认同组进程消失并收完输出后才返回。先回收 shell 避免 Darwin 对只剩未回收 zombie 的组报告 EPERM。正常 shell 退出也清理同组残留，不承诺追踪主动脱离组的 daemon。既有 delete／close 的取消和 done 等待足够复用，没有新增后台任务表或生命周期 RPC。
- 注册和提示词只增加 Bash 与 tool.Bash，不改基础正文及 Read／Write／Edit schema。文件工具旧会话通过单个增量升级，旧字节前缀保留，未变化的后续 Run 和重开不重复写入基线或增量。安全诊断复用既有工具日志，并增加 PID、退出／取消／超时／截断结果，不记录命令、输出或完整环境。

自动验证：

- `cargo test -p xw-agent -p xw-agent-runtime -p xw-sandboxed-exec --locked` 通过；覆盖真实命令、普通非零退出、非法／后台参数拒绝、双流大输出、中文截断、路径与精确授权、symlink、取消前／执行中、超时、同组残留清理、Bash → Read → 后续模型、停止／删除／关闭、重开不重放、旧基线升级，以及 Bash 意图／结果提交故障。最终输出提示补充后另复验 runtime／sandbox 与 core 工具循环。
- 正式 Agent addon `build:debug` 和 desktop worker 构建通过；`pnpm --filter xiaowei-agent test:runtime` 7 项通过。扩展现有 `tool-loop.test.cjs` 的场景复用同一 fixture，没有另建重复接线；确定性请求经过正式 Pi provider、真实 Seatbelt Bash 写入临时文件、Read 读取，再生成最终回复，检查退出码与 metadata。
- `XIAOWEI_AGENT_LIVE=1` 下同一正式链路的 Bash → Read 场景通过，使用本机配置的真实模型，最终文件严格为 `hello\nxiaowei\n`。只操作临时 Agent 根目录，结束后自动清理。
- 严格 no-deps Clippy、`just check`、renderer 22 文件／147 项通过；LLM 回归 93 项通过，另 1 项显式 live 上下文实验按默认条件跳过，不将其计为本次通过。

rebase 到 develop（`a4836e9`）后，`cargo check -p xw-agent -p xw-agent-runtime -p xw-sandboxed-exec --locked` 与 `git diff --check` 通过。用户启动当前工作区实例后，使用配对的 `just inspect identify／status／capabilities` 核实工作区、PID 和实际能力，再以 `show quick-chat` 显示窗口；结合实际 Electron 路径连接原生自动化，完成以下产品验收。inspect 只用于身份、窗口状态与显示，输入任务、展开详情和 Stop 均经实际窗口操作。此次窗口可以持续操作，不再保留此前 noWindowsAvailable／timeoutReached 作为当前阻塞。

独立验收会话为 `01a17289-afc2-740c-b87b-a347f01c1b07`，模型使用配置中的 sol。Header cwd 为 `~/.xiaowei/quick-chat/<session-id>/`。从输入框要求 Bash 写入 `ui-bash-20261025.txt` 并输出 pwd／bash-ok，再调用 Read；两个工具均显示已完成，展开 Bash 显示 `Exit: 0`，展开 Read 显示带行号的 hello／xiaowei，模型正常回复。只读核对最终文件严格为 `hello\nxiaowei\n`，14 字节，SHA-256 为 `b12fb575fd0ee83b437f656df135e27a24bb59d985bfa9f98970f7a680810ad5`。

同一会话分别运行普通 `exit 7` 和向预先确认不存在的 cwd／临时目录外路径写入。前者显示已完成并保留 `Exit: 7`；后者显示失败，详情含 `Operation not permitted` 和权限不足说明，metadata 保留实际 `exit_code=1`。目标 `~/.xiaowei/ui-bash-denied-20261025-1810.txt` 始终不存在，模型没有重试或绕过。

执行中 Stop 使用前台 shell 等待 sleep 子进程，先输出 `partial-before-stop`／`child-started`，向 `ui-bash-stop-effects.txt` 追加一次 started，并记录两个 PID。点击前核实 shell `12605` 和子进程 `12606` 均存活、PGID 同为 `12605`；点击实际停止按钮后，工具显示已停止，详情保留两行部分输出及 `Cancelled`，metadata 为 `cancelled=true`、`timed_out=false`。只读核对两个 PID 和进程组均已消失，副作用文件仅为 `started\n`，没有 after-wait；工具结果为 cancelled、RunEnd 为 aborted，其后没有新的 GenStarted。

按开发实例流程核对控制器 cwd／完整父子链及 stdin 对应的 cmux console 后，发送单个 r 重建原生模块和 main／preload。旧 Electron `8422` 退出，新 Electron `13858` 仍属于同一控制器；inspect 实例 ID 从 `74afceb2-a277-475a-85c6-edc0ea44271e` 变为 `237b040e-e681-4c2c-b544-c20a87063c5e`。启动日志确认同一会话 loaded、`repaired_bytes=0`；重新显示 Quick Chat，成功、普通非零退出、沙箱失败及停止详情均恢复，展开后输出和状态一致。

重启前后会话 JSONL 均为 60 条／39479 字节，SHA-256 同为 `34392f51a1a00429b6d5cbbb924b44804b86e8bcd83832b447bfc3cb449594a4`，包含 3 个 Run、7 次模型生成、5 对工具意图／结果。SQLite 会话行、正文文件、停止副作用文件和两个 PID 文件均未变化，没有追加记录或自动重放。验收会话与四个文件保留供复核，未改动已有用户会话内容。此前自动检查不因本次补验而重新计数；后台执行、RequestPermission、其他平台沙箱和 preset 仍未交付。

## 工具循环与文件工具（2026-10-18）

02e 与第一批 Read／Write／Edit 已完成代码接入及核心链路验收，2026-10-19 补齐实际 Quick Chat 窗口验收。系统正文、实际文件工具、cwd 和基础写入权限共同进入生产路径，后续批次未提前开放。

2026-10-25 按 Git 核对，本批已提交并合入 develop，不再是未提交工作：

| 提交 | 交付范围 |
| --- | --- |
| `347f0dd` | 上下文同步讨论／工具批次计划及 provider 实验脚本、刻画测试 |
| `39b7bb5` | 系统上下文基线／增量的领域状态、持久提交、恢复与失败边界 |
| `cc2f049` | 基础提示词、cwd、生产工具循环、Read／Write／Edit、PB／worker／最小 UI 接线及验收 |

三项通过 `cd91fa6` 合入 develop；当次提交核对基线为 `4ec62bf`。以下检查与窗口证据属于当时实施验收，本次文档整理未重跑。

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

本批代码及约定验收已完成并包含在上述提交中，02e 临时计划已删除；其他未交付工具和动态工具适配限制仍按既有 record／后续批次推进。

## 持久文本聊天里程碑

截至 2026-10-07，xw-agent-types、xw-agent-rollout、xw-agent-runtime、xw-agent、xiaowei-agent 及正式 napi 已接入产品。Quick Chat 经 Agent typed RPC／SubscribeSession 使用同一 App Server，执行多轮文本／思考、停止及失败处理，显示缓存与模型历史分离。隐藏或关闭观察不停止 Run；新建等待当前 Run 结算但保留旧会话。

统一 AgentHost 提供生成、模型信息及辅助模型引用，wrapper 分别调用 Llm.Generate、Llm.GetModelInfo、ModelSettings.GetAuxiliaryModelRef。模型查询失败保持原引用并显示持续 hint，预算回退为 256_000／32_768。可观测的 SSE 路径记录首个完整 data event 的时间，非 SSE／不可注入路径保持未知。模型与思考选择独立持久提交，Run 保留自身快照；composer 外部右上方 chip 的位置和样式已按用户反馈修正并获确认。

会话目录由 xw-agent 自己管理 sessions.sqlite，宿主只传根目录；列表不扫描 JSONL。标题／自动生成开关、归档／删除状态和维护策略在 SQLite，模型配置及执行历史在 JSONL。已接会话列表、切换、重命名、归档／恢复、批量删除接口及设置归档页；归档页只提供单条删除，恢复只 toast。核心定时维护与查看保护已接入，策略保存成功后替换维护任务。Quick Chat 启动选择最后更新的未归档会话，不额外保存选中 ID。

JSONL 采用精简 v2：Header 只写一次，第二条 Meta 保存初始模型选择；后续不重复版本、会话 ID 或 sequence，RunStarted 内嵌必要 RunContext。codec 从验证过的前缀恢复冗余字段，保留响应来源、签名、原始 JSON、独立测量及单调耗时。文件层负责锁、提交与尾部修复，core 负责业务中断结算；写失败终止 Run，下次 query 校验必要尾部后才能继续。没有自动执行历史模型／工具或用户修复入口。

## 与旧版的关键差异

- 采用旧 Rust 路线，但模型调用适配当前 Pi／LLM 契约，不搬入旧 xw-llm；领域消息保留当前契约全部已知回放字段。PB 转换在 xiaowei-agent，types 不依赖外部业务协议。
- xw-agent 充当可嵌入的 App Server，使用 Agent proto 而不依赖 Gateway；请求／响应及直接业务事件参考 Codex App Server 的边界，不承诺 wire 兼容。不采用旧 cursor／ReadChanges 草案。
- SQLite 会话目录由核心自管，不接 Storage Gateway DAO；标题及管理状态不是可丢弃重建的索引缓存。只使用最终 session／meta 结构，不保留开发期中间表或运行时迁移。
- 首期输入仍为 textarea，没有附件／图片输入、富文本、Skills／命令资源或旧会话导入。Read／Write／Edit、Glob／Grep 和 macOS 前台 Bash 已有实际执行能力及相应窗口验收；问答／权限及对应窗口链路已验收，真实 IME 平台复核仍随 04d 保留；其他工具和压缩仍待实施，不能宣称已全面迁移旧 Agent。
- 问答／权限已采用 pending Interaction、逐端 ACK 与唯一决定，同 Run 等待并继续；旧版 stop_loop 后另开 Run 的方式不沿用。实际验证范围见本批结果。

## 自动验证

本节保留 2026-10-07 文本里程碑的检查范围；后续文件工具批次的验证数量和范围以上文为准，不能将这里的旧数量称为当前最新结果。

| 层次 | 已完成的验证 |
| --- | --- |
| Rust 领域／文件／运行／服务／集成 | 当时 Header／Meta 调整后共 122 项通过；覆盖格式与合法前缀、引用／生命周期、写失败、跨进程锁、尾部修复、恢复不重复结算、模型查询失败、初始 Meta、SQLite 管理及任务生命周期 |
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

用户已确认 chip 样式。2026-10-07 文本 MVP 的真实模型多轮、思考、停止后再发送、新对话和错误恢复经 Electron 验证；当时另一次桌面控制尝试报 `Sky Computer Use native pipe startup failed`，未覆盖全部菜单操作。2026-10-19 的文件工具、停止及重启恢复已补齐窗口证据，见上文；该旧错误不作为当前自动化服务不可用的结论。

人工复验仍包括模型／思考选择重开及重启后的显示、会话归档页搜索／恢复／删除、维护设置保存与可见查看保护、系统剪贴板复制、原生拖动，以及从 Quick Chat 入口事项转入的搜索高亮闪动和首次设置跳转。保留这些限制，不把日志或自动测试写成全部视觉验收通过；不再为已实现能力保留重复的代码实施计划。

正文 Markdown、代码块、原文复制和有序工具展示已于 2026-10-25 接产品并验收；问答／权限本批的窗口链路和已知平台验收边界见上文。

剩余计划见[总实施顺序](../../../plans/2026-09-28-agent-chat/00-implementation-order.md)：历史分页 UI／大历史读取、后续工具批次、自动压缩、显式继续、辅助标题 Gen 记录及对应 UI／完整产品验收。FollowUp／Steering／Preempt、rewind／fork、CLI 与手机 transport 仅保留已确认设计边界。
