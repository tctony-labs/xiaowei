# xw-agent-tools-web

独立网页工具实现，依赖 runtime 的 `AgentTool`／`ToolContext` 和领域类型，不读取 desktop 设置、存储、凭据文件或 Gateway。不会自动注册工具。

`WebFetch::new()` 抓取 HTTP(S) 页面，HTTP 自动升级 HTTPS；按旧版同源／www、scheme 与端口规则跟随最多十次跳转，其他目标返回给模型显式重试。响应流限制为 10 MiB，HTML 使用 htmd 0.5 转 Markdown；支持的文本最多取 100000 个 Unicode 字符，通过 `ToolContext.extract_text` 提取。二进制只返回说明；辅助模型、提交、取消和恢复由 core 持有。

`SearchTool` 是对象安全的单源异步搜索接口。`BingSearch::new()` 免 Key；`TavilySearch::new(api_key)`、`BraveSearch::new(api_key)` 和 `SerperSearch::new(api_key)` 只持有各自的明文 Key。构造器返回 `Result`，客户端构建失败可由装配方处理。选源与缺 Key 回退在宿主装配层完成，具体实现不切源或重试。

`WebSearch::new(Arc<dyn SearchTool>)` 是固定的逻辑工具入口。`set_provider` 替换共享内存引用；每次搜索只克隆当前 Arc，不跨网络请求持锁。在途调用使用旧对象，后续调用使用新对象，声明与规则保持不变。请求失败只返回安全分类与 HTTP 状态，不输出上游错误正文。

宿主可向 `AgentService::set_tools` 传入空列表、仅 Fetch、仅 Search 或两个工具。注册 ID 建议使用稳定的 `web.fetch`／`web.search`；工具声明、规则和执行器在 session 创建时一起绑定，独立于 cwd。desktop 的选源工厂和设置订阅位于 [xiaowei-agent](../xiaowei-agent/README.md)，工具实例不保存多源 Key 配置。

```sh
cargo test -p xw-agent-tools-web --locked
cargo clippy --no-deps -p xw-agent-tools-web --all-targets --locked -- -D warnings
```

确定性测试使用本地 TLS fixture 与测试专用 CA，不放宽生产证书、URL 或端点规则。正式 addon／worker 测试位于 `desktop/tests/rust-napi/agent-web-tools.test.cjs`，在独立子进程中通过 CONNECT 代理访问固定 provider 域名，不读取用户 Key 或修改系统信任。
