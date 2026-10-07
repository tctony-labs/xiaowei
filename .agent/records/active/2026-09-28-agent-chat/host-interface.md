# 宿主接口与会话持久化

所属事项：[完整 Agent Chat](../2026-09-28-agent-chat.md)。当前实现包含统一 Host、单次文本 Agent、JSONL 基础恢复与 composer 模型／思考切换；SQLite 会话目录已由核心接入；工具、压缩生产及远程 transport 仍后续实施。历史交付事实见[实施结果](implementation-results.md)。

## 会话选择与 Run 快照

Run 固定 model_ref／reasoning 及实际采用的预算；不追踪 worker 内同引用的配置变化，不保存外部配置 token。ModelDescriptor 保留独立展示名称、可选能力及预算来源。系统指令由 host 当前调用提供，不在每个 Run 中保存全量外部设置；必要执行参数在 RunContext 中记录。

Meta 保存会话模型选择及 provider_name／model_name；标题与 auto_title_enabled 只存 SQLite。主 UI 最终组合 `tctony/sol`，中间层原样保留两个名称。名称变化不重写历史 Run；凭据、地址和完整 provider 配置不落盘。CreateSession 先查询模型信息并提交 Header／初始 Meta，普通发送继承会话选择；StartRun.config 仅为该 Run 覆盖。用户选择通过独立 SetSessionConfig 立即持久化，运行中修改只影响后续 Run。

InputAccepted 保存内容及可选单轮 selection，RunStarted.cause 保存 input→run 关联。相同 ID／相同请求返回原 Run；相同 ID／不同请求冲突。只接纳、没有 Run 的输入也保留身份，重试明确冲突，不重新接纳或自动执行。辅助标题模型每次任务查询，不从历史恢复 title_model_ref；旧 PB 字段保留编号但已忽略。

## 文件持久化与恢复职责

`xw-agent-rollout` 负责 JSONL 读写、独占 OS 写锁、提交边界和未提交尾部修复。`xw-agent` 重建模型历史、公共 Run／Item 视图与请求身份，识别未完成 Run／Turn／Gen／工具／Interaction，并追加基本中断终态。文件层不返回业务中断分类；取得写锁并提交基本结算后才允许新 Run，不自动执行历史模型或工具。

生产 main 使用 `await Agent.open(agentRoot)`，初始化放工作线程；内部同步文件操作由 Rust 服务执行。根目录由 `XIAOWEI_AGENT_HOME` 指定，默认 `~/.xiaowei`，不再附加 `agent/`；其他业务数据仍在原应用数据目录。xiaowei-agent 只将目录传给 AgentService::open；xw-agent 自己打开 sessions.sqlite、管理会话并按需恢复登记的 JSONL。正常启动／列表不扫描历史；未知版本、完整非法行及中间损坏保留并在打开该会话时报错，不阻止其他会话列表及启动。未登记文件不自动导入。

## 写盘失败的最小处理

必需记录写盘失败即终止整个 Run，取消当前生成，UI 提示检查磁盘空间／目录权限后重新发送。已显示回复可留内存，重开只展示实际保存内容；没有重试保存、积压缓存、自动重发或修复按钮。

writer 在内存保存 Ready／NeedsCheck 和最后确认字节边界。正常 Ready 连续追加不重扫；失败后拒绝追加。下次普通 query 先等旧执行结算，再保存诊断副本、清除失败写入尾部并校验，成功才收尾旧 Run、接纳新输入。仍不可写则发送报错，不调用 Host。当前实例知道保存失败时补 Failed，冷打开原因未知时补 Interrupted；未知真实结束时间保持未知，不伪造工具结果。

冷打开先取得写锁；另一个宿主仍持有时明确冲突，不修复或生成中断记录。完整行／换行／flush／sync_data 成功后才推进确认边界；多条记录不是事务。冷打开完整有效但未换行的 EOF 也不提升为提交，先保存诊断再截断；未知版本／kind／field 即便在末尾也保留报错。

## 统一 Host 注入契约

由 `xw-agent` 公开唯一 `AgentHost`，核心接收 `Arc<dyn AgentHost>`。纯生成／模型数据归 `xw-agent-types`；Future／Stream／取消由执行边界提供并从核心重导出。runtime 不反向依赖核心，核心桥接为 runtime 内部 LlmGeneration。CLI 可实现同一 Host，不依赖桌面业务模块。

```rust
pub trait AgentHost: Send + Sync {
    fn generate(
        &self,
        request: GenerationRequest,
        cancellation: CancellationToken,
    ) -> GenerationFuture;

    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture;

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture;
}
```

### 定义归属与依赖

| Host 方法 | 桌面 adapter 实际调用 | 数据来源与语义 |
| --- | --- | --- |
| generate | Llm.Generate | 现有 worker；唯一流接口，聊天和标题共用，压缩后续消费 |
| get_model_info | Llm.GetModelInfo | worker 生成使用的同一个已应用模型 Map；返回引用、独立 provider_name／model_name、输入种类、reasoning 支持、窗口及输出上限 |
| get_auxiliary_model_ref | ModelSettings.GetAuxiliaryModelRef | 设置 owner 的 smallTextModelRef；None 表示未配置，不回退聊天模型 |

`AgentHost` 是 Rust 消费接口，不是 Gateway service。每个 RPC 的 proto、handler 和 owner 归提供该能力的模块。xiaowei-agent 使用 typed Gateway client，转换为领域数据；不读取设置文件、完整快照、凭据或上游目录。xw-agent 不依赖 Gateway、ModelSettings 或 Storage。

ModelConfiguration 下发独立 provider_name；SDK 的 provider 与模型 name 保留原语义。Host adapter 不组合展示文本、不提供第二条配置推送路径。模型说明查询不带取消参数；取消生成仍使用 CancellationToken。

### 查询失败与预算回退

模型不存在、Host 不可用或非法响应分别返回安全错误。读取历史不依赖查询成功，继续调用原 model_ref／reasoning，能发就发，失败给出真实 Run 错误，不自动替换模型。能力未知保持 None，不伪装为不支持；ModelBudget.source 区分 Host 与 Default。

前端共享默认、TS 配置缺省和 Rust 回退均为 `256_000` 上下文／`32_768` 最大输出，不改写显式配置或历史预算，也不强行填写原本缺省的 Generate.max_tokens。预算回退可能影响后续压缩时机；本轮尚未接压缩生产者。

### 查询警告的会话投影与 UI

AgentSession.model_info_warning 和 SessionModelInfoWarningUpdated 表达当前查询异常，首帧／ReadSession 携带当前值，事件缺省 warning 表示清除。警告不落 Meta、不自行改变 metadata_revision、不等于文件损坏。查询代次隔离迟到结果；创建／订阅／Run 开始查询，无定时重试，生成成功不清除警告。

Quick Chat 在消息区底部／输入区上方参考旧版 hint，以分隔线和居中小字显示“xxx 模型配置获取失败，部分功能可能出现异常”。xxx 从独立名称最终组合，缺名称用 model_ref；与发送错误分别维护。已有会话即使全局设置读取失败仍沿用自身配置发送。切换和重连以订阅首帧恢复提示。

### Composer 模型与思考强度切换

按用户要求跳过 Storybook，直接接现有 textarea。模型与思考选择器位于 composer 外部右上方的独立一行，采用旧版的紧凑 chip 样式、小字号、弱化文字、圆角和悬停背景，思考 chip 保留脑形图标；下拉菜单使用既有 Select portal／键盘交互，向上展开。模型选项显示提供商／模型名称；思考档位来自 thinkingLevels 和配置映射，菜单已移除“模型默认”选项。未指定档位时 chip 显示“默认”，没有可选档位时禁用。新模型支持当前档位则保留，否则仍清除显式覆盖、采用模型默认；未知能力保留当前值。

空白会话只改本地草稿选择，首次发送前 CreateSession 提交。已有会话发送 SetSessionConfig(config, expected_metadata_revision)，提交后广播 SessionConfigUpdated；响应仅确认 revision，不覆盖活跃订阅缓存。保存中禁用新选择和发送，停止仍可用；冲突／保存失败显示反馈并保留服务端已提交配置。运行中的快照保持原模型／思考。

### 生成流与观测

generate 只有一次成功／失败终态；失败、取消和无终态断流不把 partial 当完整结果。Host adapter 在 Future／流丢弃或取消时释放上游。Gen 开始／结束由 Rust 采集；独立 FirstSseReceived 表示 worker 首个完整 SSE data event 的 Unix 毫秒时间，不用 headers、Pi start 或正文首字代替。

worker 对支持 fetch 注入的 OpenAI Completions／Responses／Codex Responses、Azure Responses、Anthropic 路径观察原响应字节，按跨 chunk 的 LF／CRLF／CR 识别 data event，跳过心跳，不保留正文、不 clone／tee；取消、背压及错误沿原流传播。不可注入的 Google／Vertex、非 SSE／WebSocket 保持未知，不改变 transport。时间至多一次经 Generate PB → Host adapter → runtime 传递，聊天写 GenFirstSseReceived；已采集事实在失败时仍保留。

标题使用同一流的完整收集函数，SQLite 保存最终标题／自动生成开关；辅助标题 Gen 目前有运行日志，但尚未把独立生命周期写入 JSONL，留在标题持久记录后续工作。

## 与客户端协议的区别

AgentHost 是核心向宿主请求模型能力的 Rust trait；客户端控制协议是 agent.proto 的会话／Run 方法和直接事件，两者不混用。xw-agent 可用 Agent proto，但 runtime 使用 types 中的生成数据和自身执行接口。Codex 对齐的源码基线见[架构](architecture.md)，当前方法和同步语义见[控制协议](control-api.md)。

我们显式建模会话 model_ref／reasoning：SetSessionConfig 修改后续默认，StartRun.config 只覆盖当前 Run。这是本项目约定，不逐字段复制 Codex；参考版本的 ThreadStartParams 没有同名顶层 reasoning_effort，TurnStartParams 的 model／effort 可以影响当前及后续 turn。
