# 架构、分包与依赖方向

所属事项：[Agent Chat](../2026-09-28-agent-chat.md)。当前已交付持久文本聊天；工具执行和远程 transport 尚未实现。

## 技术路线与源码参考

采用旧版 Rust Agent 迁移路线，Pi 继续承担模型适配，不将 Agent Core 改为 TS，也不整体引入 codex-core。迁移须核对业务、持久化、恢复与文件生命周期，不能只迁 UI 或替换模型调用。

| 来源 | 核对基线与采用范围 |
| --- | --- |
| 旧 XiaoWei | `933a6997c1d2bc44e2addd608b6a5d8d8731a2d3`；agent_loop/run.rs 的工具循环、steering／follow-up、预算和压缩，旧 xw-agent-session 的 JSONL／SQLite，xw-agent-app 的投影及交互 |
| Codex 执行与历史 | `c0d26949be4144c751894ae96e28d3db2208b764` 及 `b741e480e203f037ca726bc2a76d99a8e8668e66`；Turn、历史重建、工具编排及跨进程 writer |
| Codex App Server | `b741e480e203f037ca726bc2a76d99a8e8668e66` 与 `7f892275e31002f0422477c6219189284560e689`；统一 InProcess／Remote client、会话管理和直接业务事件。旧 notes 基于 `250de82bfb51a210325e88bfe1f7c30b0fa514f0`，只作为阅读线索 |

Codex 的 Thread／Turn／Item 对应我们的 Session／Run／Item；本项目内部 Turn 包含 Gen 及其工具结果。借鉴职责和生命周期，不承诺 Codex wire 兼容或相同产品能力。Pi 的类型与旧字段对齐见[领域类型](model-types.md)。

## 当前包与职责

| 包／位置 | 职责与公开边界 |
| --- | --- |
| `xw-agent-types` | 领域身份、消息、生成纯数据、模型选择／说明、RunContext、rollout 和严格 compact codec／校验。lib.rs 显式导出，内部模块私有；不是公共 RPC 协议，不依赖 contracts |
| `xw-agent-rollout` | JSONL 读写、提交边界、跨进程 writer 锁、尾部修复及文件生命周期；不管理 SQLite，不决定业务 Run 如何恢复 |
| `xw-agent-runtime` | 文本 Gen 执行、取消、内部事件及完整流收集；消费 types，保持内部执行 trait，不接受 UI RPC、不依赖 Gateway。工具循环与压缩后续扩展 |
| `xw-agent` | App Server：会话／输入／运行所有权、上下文重建、公共 Run／Item 投影、直接事件、标题、SQLite 目录和自动维护；定义统一 AgentHost。公开服务使用 Agent proto，不依赖 Gateway 或外部业务 service |
| `contracts/proto/xiaowei/agent.proto` | Request／Response、Session／Run／Item 与公共事件；由 xw-contracts／xiaowei-contracts 生成消息和 service descriptor，不包含 Rust trait 或宿主运行对象 |
| `xiaowei-agent` | 薄集成层：实现 AgentHost、LLM 消息 codec、Gateway handler 和 consumer binding；不保存第二份会话／运行状态 |
| `xiaowei-agent/napi` | Rust xiaowei-agent-napi／npm xiaowei-agent：Node 生命周期、endpoint 与日志适配；main 传目录并装配依赖 |
| `desktop` main／LLM worker | main 装配同一服务及关闭顺序；worker 提供生成和模型说明，ModelSettings owner 提供辅助引用与全局偏好 |
| `desktop` renderer | typed Agent client、快照／事件缓存、pending 请求、草稿、菜单、焦点和滚动；不执行 Agent 循环、不直接生成模型 |

xw-agent 的主要文件为 service／session／input／execution／events、context／persistence／recovery、catalog／index／retention、model／title／host。投影与实时事件已有实现，后续不按旧草案重复新增 run.rs／changes.rs 或另一套同步服务。

调用方向：renderer → contracts + Gateway client → xiaowei-agent handler → xw-agent → runtime／rollout；runtime／rollout → types。模型调用由核心桥接 AgentHost，wrapper 实现外部 typed RPC。外部 contracts 不依赖 core／Gateway／types，内部模块不反向依赖 wrapper／Electron／napi。详情见[Host](host-interface.md)。

核心不消费 ModelSettings、Storage 或外部 Llm service，不提供 AgentIndexDao／存储 Gateway 接线；SQLite 目录是核心私有实现。统一 Host 只提供生成、模型说明与辅助引用，不注入 provider 管理对象、完整设置或配置 token。通用文件／进程／HTTP 基础设施可按实际工具需要使用，App 专属能力后续由宿主注入。

## 文件与业务恢复边界

文件包统一叫 xw-agent-rollout；旧源码中的 xw-agent-session 只是迁移参考。rollout 取得锁、校验和修复未提交尾部，core 根据已提交记录识别未完成运行并追加基本结算。一次打开完成此过程，提交成功才允许新 Run，不提供两个公开恢复步骤，不重执行历史模型或工具。

AgentService::open(host, root) 初始化核心自有目录，生产 Node 使用异步 Agent.open(root)。正常启动／列表只读 SQLite，具体会话按需加载；格式和管理规则见[历史格式](history-format.md)。关闭等待维护、运行和标题任务结算／释放 writer，再关闭 endpoint 和 LLM 依赖；初始化失败逆序清理。内存 create 仅保留 fixture 用途。

## CLI 与远程控制边界（未实现）

桌面本地客户端和后续 CLI／手机复用同一 App Server 协议。手机连接终止于桌面宿主，由远程虚拟连接转发请求／响应、订阅及交互回应到同一 handler；不直接调用 runtime，不另建手机队列或状态同步业务。远程身份与权限由可信宿主建立，不能信任 payload 自报身份，也不能开放任意内部 Gateway 能力。

必须区分两种共享：

1. **共享活跃运行**：多个客户端连接同一服务实例，共享一个运行所有者和投影；各自有界订阅、首帧替换缓存，断连不停止运行。跨客户端修改由服务串行化并校验预期 metadata／archive revision 或 run ID；未来交互决定只接纳一次。
2. **复用持久数据**：独立宿主实现 AgentHost、传相同数据根，前一 writer 完全释放后再接管会话。锁覆盖可写 Journal 生命周期；其他 writer 活跃时返回冲突，不修复尾部、不补中断、不删除其文件。共享 JSONL 不等于共享活跃任务。

Rust CLI 可以直接依赖 xw-agent；控制桌面活跃 Agent 的 CLI 应作为协议客户端。包拆分不意味着已有纯 Rust CLI 产品，当前宿主模型实现仍使用 TS worker。CLI、daemon、网络 transport、配对认证、能力协商、稳定设备身份及断网重连均后续实施。远端路径和工具副作用属于执行宿主，不能自动当作手机本地路径。

首期工具进程隔离拟迁移旧 xw-sandboxed-exec 的 macOS／Seatbelt 能力，尚未创建该包；具体依赖和平台边界在既有工具切片实施时核对，不预建空包。

源码定位：[统一 client](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server-client/src/lib.rs)、[进程内 server](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/app-server/src/in_process.rs)、[公共实体](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[writer lock](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/rollout/src/writer_lock.rs)。
