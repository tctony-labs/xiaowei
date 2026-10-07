# xiaowei-agent

桌面 Agent 集成入口。Rust 包将 `xw-agent` 的 App Server 接到 Gateway，并注入统一 AgentHost：调用 Llm.Generate、Llm.GetModelInfo 及 ModelSettings.GetAuxiliaryModelRef；不读取完整 ModelSettings 快照、凭据文件或 Storage。领域消息与 LLM PB 的全字段转换归本包，runtime 和 types 不依赖 Gateway。

Node 宿主使用正式 npm 包 `xiaowei-agent`：`await Agent.open(root)` → `createGatewayEndpoint()` → `attachRustNapi`。目录原样传给 `xw-agent::AgentService::open`；SQLite 与会话管理均归核心，无存储 Gateway 接线。持久初始化在工作线程完成；`Agent.create()` 保留为内存 fixture 入口。激活后启动核心会话维护，并使用 endpoint 分配的后台 client；激活前业务请求不可用。聊天命令经 Agent service，napi 不额外暴露发送／停止入口。

退出时先等待 `agent.close()`，再关闭 attached endpoint，最后关闭 LLM worker。关闭会取消并等待运行，随后清空后台 client；环境 teardown／endpoint GC 只能触发取消与释放，不能代替显式异步关闭。

```sh
cargo test -p xiaowei-agent --locked
pnpm --filter xiaowei-agent build:debug
pnpm --dir desktop build
pnpm --filter xiaowei-agent test:runtime
```

runtime 测试使用正式 addon、构建后的 LLM worker 与本地模型协议服务器；不读取用户模型凭据、不启动 Electron。共享 napi 构建和相关 fixture 测试需串行。
