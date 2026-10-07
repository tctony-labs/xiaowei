# xw-agent

传输无关的 Agent App Server，使用 `xw-contracts` 的 Agent 请求／响应与公共视图。内部复用 `xw-agent-types`，通过本包的统一 `AgentHost` 接收生成、模型信息与辅助模型引用；不依赖 Gateway、napi、ModelSettings 或 Storage。

从包根使用 `AgentService`、`AgentError`、`EventSubscription`、`SubscriptionError` 与 `protocol`。先创建会话，再以必填 `session_id` 调用 `subscribe_session`；第一帧 `SubscriptionReady` 已携带该单个会话完整快照，并与观察者登记原子完成；随后顺序消费快照之后的直接业务事件。未知／已删除会话返回 `AgentError::NotFound`。订阅过载明确返回 `Lagged` 并结束，需要重新订阅并用新首帧替换缓存。独立 `read_session` 只用于查询，不能覆盖活跃事件缓存。关闭观察者不关闭服务，宿主通过 `close().await` 释放服务并唤醒观察者。

`AgentService::new` 提供内存模式，`AgentService::open(host, root).await` 打开核心自有的 `sessions.sqlite` 与 rollout 文件层；宿主只传目录和模型 Host，不接存储 Gateway。正常启动／列表仅查 SQLite；打开登记会话时按需校验 JSONL、结算遗留运行、恢复历史与配置，不执行旧模型请求。`with_rollout` 仅保留显式 legacy fixture 的文件模式。所有会话控制方法使用同一公开服务入口。会话支持模型配置、幂等创建、单个活动 Run、完整公共历史和有界事件订阅。`start_run` 原子接纳稳定 input ID，立即返回 Run；重复原请求复用同一 Run，冲突请求不修改状态。后台执行单次 Gen，只将完整成功 AssistantMessage 加入下轮上下文，失败／取消保留用户输入和部分显示。`interrupt_run` 指定准确 Run，终态通过 RunCompleted 确认。异步删除和关闭取消并等待任务；持久模式关闭后可从同一根目录重开；内存模式关闭后历史丢失。

每会话模型历史加原始幂等请求的编码字节合计不超过 8 MiB，显示投影不超过 8 MiB，Run／输入关联最多 1024 项；不会静默淘汰身份。ReadSession 完整结果和订阅首帧超出 1 MiB 编码预算时明确 ResourceExhausted；订阅积压受 64 帧／1 MiB 限制。较大历史的分页属于后续工作。生成过程仅记录安全身份、阶段和耗时，不输出正文。

```sh
cargo test -p xw-agent --locked
cargo clippy --no-deps -p xw-agent --all-targets --locked -- -D warnings
```

持久宿主在依赖就绪后调用 `Arc<AgentService>::start_maintenance()` 启动会话维护，或通过 `maintain_sessions().await` 执行单次检查；`close().await` 会先停止维护再关闭数据库。Gateway handler 和桌面绑定由 xiaowei-agent 集成层承担，不在此包注册 routes。

模型／思考选择通过 `set_session_config` 独立提交，并以 metadata revision 校验冲突。`start_run.config` 只覆盖该 Run，不修改会话默认。运行中切换不会改变已经捕获的配置。模型信息失败保持原引用可发送，警告通过快照／事件同步；实际预算回退为 256_000／32_768，未知能力保持未知。标题任务每次从 Host 查询辅助引用；标题及来源只保存至 SQLite，辅助引用不落 Meta。

`xw-agent-rollout` 负责文件提交和尾部修复，本包负责上下文重建／业务结算。写盘失败终止 Run；下一条 query 在 NeedsCheck writer 上先修复并收尾，成功后开启新 Run，无自动重发。只有 InputAccepted 而未开始 Run 的输入仍保留身份，重试返回冲突，不重新接纳。持久模式列表支持普通／归档过滤和分页；归档先停止结算，取消归档后才能打开。删除先提交 SQLite deleting，再直接清理登记文件和自有 workspace，成功后移除记录；失败保留状态，重开只重试已知删除路径。标题更新不追加 JSONL，数据库故障明确报错，无历史扫描兜底。
