# xiaowei-agent

桌面 Agent 集成入口。Rust 包将 `xw-agent` 的 App Server 接到 Gateway，并注入统一 AgentHost：调用 Llm.Generate、Llm.GetModelInfo 及 ModelSettings.GetAuxiliaryModelRef。领域消息与 LLM PB 的全字段转换归本包，runtime 和 types 不依赖 Gateway。

Node 宿主使用正式 npm 包 `xiaowei-agent`：`await Agent.open(root)` → `createGatewayEndpoint()` → `attachRustNapi`。目录原样传给 `xw-agent::AgentService::open`；SQLite 与会话管理均归核心，无存储 Gateway 接线。持久初始化在工作线程完成；`Agent.create()` 保留为内存 fixture 入口。激活后启动核心会话维护，并使用 endpoint 分配的后台 client；激活前业务请求不可用。聊天命令经 Agent service，napi 不额外暴露发送／停止入口。

desktop 先接入 Storage／Settings 再激活 Agent。异步 activate 先订阅 SettingsChanged，再读取当前有效搜索源与其单个明文 Key，通过 `tools::create_search_tool` 构造 `Arc<dyn SearchTool>`，组装 WebSearch／WebFetch 并注入 core，成功后才 ready 和启动维护。工厂是唯一选源位置；搜索配置及 XOR xwwx＋Base64 还原由 desktop Settings 持有，不进入 Agent 的 SQLite／JSONL 或模型 Host。

每次已提交 SettingsChanged 都串行重读运行配置，即使脱敏字段相同也处理 Key 替换；配置未变时复用实例，变化时只替换 WebSearch 内部 provider。在途请求保留旧对象，已有 session 后续搜索透明切源。普通工具请求不读 Settings 或还原 Key。刷新失败保留当前对象并记录安全的阶段／源错误，保存结果不回滚；后续成功通知可恢复刷新。Settings.TestWebSearchProvider 用保存的单源 Key 构造临时对象，不替换当前 provider 或写聊天历史。

退出时先等待 `agent.close()`，再关闭 attached endpoint，最后关闭 Settings／Storage 和 LLM 依赖。关闭先停止配置订阅／装配任务，再取消并等待运行，随后清空后台 client；环境 teardown／endpoint GC 只能触发取消与释放，不能代替显式异步关闭。

```sh
cargo test -p xiaowei-agent --locked
pnpm --filter xiaowei-agent build:debug
pnpm --filter xiaowei-agent test:runtime
```

runtime 测试自动构建隔离的 LLM worker，使用正式 addon 与本地模型协议服务器；不读取用户模型凭据、不启动 Electron。产物目录及复用方式见 [desktop 测试](../../desktop/tests/README.md)。共享 napi 构建和相关 fixture 测试需串行。
