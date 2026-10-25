# xw-agent-runtime

提供 Agent 内部生成执行边界、单次生成收集、文件工具与沙箱 Bash 原语，独立于 App Server 公共协议、Gateway、napi 和具体 LLM provider。生成请求／事件／错误、消息、身份和用量复用 `xw-agent-types`；对外统一 AgentHost 定义于 xw-agent，核心将其桥接为本包内部 LlmGeneration。

包根导出 `LlmGeneration`、`GenerationRequest`、`GenerationEvent`、`GenerationError`、异步流／future 别名和取消 token。实现方必须在开流与消费阶段响应取消，并在 future／stream 被释放时取消上游工作。错误不得携带原始响应正文或凭据。

`execute_text` 使用 App Server 提供的身份，单次调用 generate 并返回唯一 RunOutcome。内部 RunEvent 通过有界 channel 传递增量；取消覆盖开流、读取和发送等待。完整 STOP／LENGTH 文本或合法 TOOL_USE 消息用于成功结果；TOOL_USE 要求非空调用、唯一 ID 和完整对象参数，截断参数不会执行。部分显示不作为模型历史。RunRequest／RunOutcome 沿用历史命名，只代表本次生成；多 Turn 循环及记录提交由 xw-agent 编排。记录 Gen 开始／结束和单调耗时；来源未提供首 SSE 时间时保持 None。实际 LLM adapter 由集成层提供，不增加通用 `types.rs`。

`complete_text` 供标题等辅助任务消费同一生成流，只返回通过校验且没有工具调用的完整成功 AssistantMessage，不向聊天投影发送增量；开流、读取、失败与取消沿用同一生成边界。调用方提供模型引用、指令和生成选项，并拥有任务超时与业务结果的提交。

```sh
cargo test -p xw-agent-runtime --locked
```

`tools::FileTools` 提供 Read／Write／Edit 的结构化声明和顺序执行原语：文本分页、行号、截断、已提交读取去重、覆盖写入／创建父目录、精确唯一替换及 replace_all。PDF 暂不支持。写操作先按实际路径与 symlink 检查 cwd／临时目录／已有有效授权；cwd 为 home 或其祖先时不获得整棵目录写权限。读取保留操作系统权限约束；工作区内 `.git` 不额外禁写。

`tools::search_declarations()` 提供 Glob／Grep，复用同一 FileTools 与 cwd 路径解析，读取仍受操作系统权限约束。Glob 使用 globset／walkdir，自动补 `**/`，跳过 node_modules／target 和未在 pattern 点名的隐藏段，不应用 gitignore；只保留修改时间最新的 500 个文件，返回绝对路径，不跟随目录 symlink。Grep 使用 grep-regex／grep-searcher／ignore，返回绝对路径、行号与匹配行；目录搜索沿用 ignore 库的 `.ignore`／Git 忽略规则和默认隐藏过滤，include 类型白名单可放行匹配的隐藏文件。include 沿用旧版文件类型筛选解释，适用于 `*.rs`、`*.{ts,tsx}` 等表达式；显式文件目标不应用目录忽略或 include 筛选。Grep 不对文件顺序额外排序，最多返回 5000 个匹配行。

两种搜索的文本输出不超过 64 KiB；数量或字节超限时明确提示缩小范围，单行超长按 UTF-8 边界截断。遍历／文件读取错误按旧版跳过，结果正文与 metadata 标明跳过数量和可能不完整，不能把此时的无匹配当作完整检查。非法参数／模式返回工具错误。`execute_cancellable(name, arguments, cancellation)` 在阻塞池中执行；搜索在遍历及流式读取阶段检查取消，调用方等待实际结束再提交 Cancelled，不在取消后继续生成。原有 execute 入口保留，Read／Write／Edit 已开始的操作仍按实际结果结算。搜索 metadata 包含 matches／shown、truncated 与 skipped_errors；Grep 截断时 matches 是已显示的下界，不是完整匹配总数。

`tools::bash::declaration()` 仅在 macOS 提供 Bash 声明，异步 `execute(cwd, grants, arguments, cancellation)` 返回 `BashOutcome`。参数为必填 description／command 与可选 timeout_ms，默认 30 秒，限制到 100 毫秒至 600 秒。命令通过绝对路径 `/usr/bin/sandbox-exec` 启动 `/bin/bash -c`，继承宿主环境，stdin 关闭；不提供后台参数或超时转后台。

Bash 复用文件工具解析后的可写路径，通过 [xw-sandboxed-exec](../xw-sandboxed-exec/README.md) 生成 Seatbelt 策略。允许读取与网络，写入限制为 cwd、`/tmp`／`/private/tmp`／`~/tmp` 与已有有效授权；home 或其祖先不自动获得目录写权限，文件级授权只允许精确文件。子进程继承策略，`.git` 沿用普通写入规则，不为 `.bsk` 增加例外。命令正则拦截是补充防护，写入边界由系统沙箱执行。其他平台不注册 Bash，直接执行入口也返回不支持错误。

stdout／stderr 并行排空，各保留 32 KiB；合并后最多保留 30000 字符并标注首尾截断，metadata 保存实际输出字节数、退出码、耗时、截断、超时与取消状态。普通非零退出仍是带退出码的成功工具结果；参数／启动错误、检测到沙箱拒绝、超时或取消形成错误。取消与超时对独立进程组发送 SIGTERM，500 毫秒后回收已退出 shell 并发送 SIGKILL；正常 shell 退出也清理同组残留子进程，确认进程组消失并收完输出后才返回。无法确认回收或输出结果时返回 `BashError::ResultUnknown`，由 core 保留未知副作用保护并停止生成。进程组清理不承诺管理主动脱离进程组的 daemon。
