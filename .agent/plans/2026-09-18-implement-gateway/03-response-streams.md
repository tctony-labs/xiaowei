# 03：可取消、有背压的响应流

主事项：[实现核心 Gateway 通信机制](../../records/active/2026-09-18-implement-gateway.md)。依赖 00、01、02；本计划范围已由用户确认，尚未实施。Electron 边界和真实业务 facade 随 Plan 04 接入。

## 范围与文件

实现请求对应的单向响应流及反向取消／拉取控制，不实现通用双向 pipe、端点转交、断线续传或 LLM provider。不将 token 流伪装成可合并的状态 event。

| 文件／目录 | 修改内容 |
| --- | --- |
| `gateway/ts/src/core/stream.ts` | TS AsyncIterable、next／return／cancel、signal 和终态管理 |
| `gateway/ts/src/core/registry.ts`、`src/main/native.ts` | stream handler 注册、owner／caller 句柄表、open／next／cancel 路由 |
| `gateway/rust/src/stream.rs` | typed Rust stream、取消句柄、惰性 pull、生产者任务与限额 |
| `gateway/rust/src/napi/` | 异步开流／取项／取消；不跨 FFI 传 Rust Stream 对象 |
| 两端 protocol 及生成绑定 fixture | 统一 stream frame／终态、生成 chunk codec 与版本检查 |
| TS／Rust／两个 native 包测试 | 本地、跨 `.node` 的有序、背压、取消和资源释放测试 |

## 执行步骤

1. 定义 stream route 的 request／chunk 契约与生成 adapter。client API 为 `gateway.stream(route, request, { signal })`；open resolve 后返回 typed iterable。生成接口必须与 invoke／event 区分，不能将类型不匹配当作普通 handler 错误延迟暴露。
2. 实现 open 握手：调用方先登记 open request ID 和 abort listener，再请求 owner；owner 创建惰性流并返回 stream ID，完成端点关联后才允许 next。取消发生在 open 完成前时记录有限生命周期的取消状态，迟到创建的生产者立即关闭；每个 pending open 都必须有超时，不能泄漏取消记录。
3. 实现每流一个在途 next，返回单条 `{ seq, chunk }` 或 end／error。同流并行 next 拒绝并给出明确错误；不同流独立运行。main 绑定原 owner 实例，不重新查找同名新 owner；丢失连接不重试 next、不重放生成请求。
4. 实现 client terminal 状态。正常 end 让迭代结束；错误让 next reject；显式 cancel 中止 pending next，之后取消可重复调用。`for await` break／异常通过 return 取消。end、error、cancel 竞争只有一个终态获胜，服务端及时释放句柄，client 在本地处理终态后调用，不能不断保留 tombstone。
5. 实现取消控制路径：不能与等待下一条数据共用会阻塞 cancel 的锁或串行队列；同步设置取消标记，再异步等待 producer 清理。关闭 owner、调用方会话断开或 native 环境销毁时，pending open／next 都获得明确完成结果。关停等待有界，无法中断的副作用要报告，不伪称已回滚。
6. 实现端到端 pull：不消费时 owner 不继续 poll 上游；main／napi 不做独立预读。主动生产者通过有界队列适配，并同时限制单 chunk 字节、队列项数和字节、每 caller／owner 流数。在代码中定义可查阅的默认 policy、owner 可配置范围及计量方式（PB 编码后的字节长度，同时限制生成端解码对象／主动生产队列的容量），并回填 record。满队列等待、超大 chunk 显式失败；不能先把全部 chunk 放进无界 TSFN／IPC 队列再声称有背压。
7. 分开定义 open timeout、pending next 的生产 idle timeout、无消费的 idle timeout、可选总时长；不套用普通 invoke 的整次 30 秒上限。待消费和待生产两个方向分开计时，不因消费者慢误报生产失败。用可控时钟验证，避免长时间实际 sleep。
8. 流本地调用复用同一接口但直接 poll 本地 handler，不走 JS。远端通过已验证的 napi adapter 拉取；调用上下文不可提升权限，stream ID 仅用于句柄寻址，不赋予跨 caller 操作权限。
9. 用模拟 SSE reader 验证：下游变慢会停止读取本地上游，cancel 关闭 reader；明确这是本地控制，不保证远端模型停止生成／计费。测试不依赖外部网络或密钥，不引入真实 LLM route。

## 验证与完成标准

- 空流、单项、多项、生成中错误、生成前失败、结构化 chunk／bytes，无乱序、无丢项、无合并；契约错误发生时 producer 被取消。
- 极慢／停止消费时，所有应用层缓冲项数与字节维持 policy 上界；超大 chunk、过多活跃流和不服从暂停的生产者明确失败，不无限增长。
- open 未完成就 abort、pending next 时 cancel、自然结束与 cancel 竞争、消费者 break、Rust drop、重复 cancel；任务、注册表、回调和 permit 最终归零。
- owner 移除／重接和 caller 会话消失时旧流结束，新 owner 不接受旧 stream ID；另一 caller 无法 next／cancel 他人的流。
- TS → Rust、Rust A → main → Rust B、Rust 本地以及 TS 本地流使用相同 fixture；本地路径 remote spy 为零，跨模块 producer 在取消后退出。
- 消费者停止消费达到 idle timeout 后资源释放；生产者正常等待但未超过其 policy 不被 unary timeout 误杀；定时器在 terminal 后清理。
- `cargo test -p xw-gateway --no-default-features`、TS 检查／测试通过，重建两个受影响 napi 包再跑 native stream 集成测试。尚未有真实 Electron 验收不能宣称 renderer 链路完成，交由 Plan 04。
- 回填流状态机、policy 默认值和验收证据，再删除本 Plan。
