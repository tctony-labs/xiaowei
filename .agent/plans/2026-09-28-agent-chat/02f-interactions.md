# 02f：两阶段交互与权限决定

前置：[02e](02e-tool-loop.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：AskUserQuestion／RequestPermission 经同一 App Server 完成逐端接收确认、唯一决定和运行继续。

范围边界：不实现手机 transport、网络身份协商、稳定设备清单或跨重启送达审计；不新增审批视觉。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `contracts/proto/xiaowei/agent.proto` | Interaction／Delivery 视图；ObserveInteractions 响应流、AcknowledgeInteraction 与 RespondInteraction |
| 新增 | `crates/xw-agent/src/interactive.rs、interaction_delivery.rs` | 持久审批／问答状态和决定，与逐 caller observer／delivery 接收状态分开 |
| 新增 | `crates/xw-agent-runtime/src/permission.rs` | 服务端权限范围与决定消费；不从普通聊天文本获得授权 |
| 新增 | `crates/xw-agent-runtime/src/tools/core/mod.rs、ask_user_question.rs、request_permission.rs` | 迁移结构化问题与权限请求，保留选项／自由文本 |
| 修改 | `crates/xw-agent-runtime/src/lib.rs、text.rs、tools/mod.rs、agent_loop/tool_execution.rs` | 通过实际交互接口等待决定，模型流释放后等待；取消使请求失效 |
| 修改 | `crates/xw-agent/src/lib.rs、execution.rs、service.rs、tool_registry.rs、events.rs、persistence.rs`、`crates/xiaowei-agent/src/gateway.rs` | 接同一实例、注册 stream／unary，交互／送达变化共享投影 |
| 修改 | `crates/xw-agent/src/recovery.rs` | 消费 01a 的 InteractionOpened／Resolved／Expired，接重启结算；类型在 01a 已定义，接收事实不进入 journal |
| 新增 | `crates/xw-agent/tests/interactive.rs、interaction_delivery.rs` | 真实 typed RPC／响应流测试两端送达、乱序、竞争与生命周期 |

## 实施顺序

1. 只注册 AskUserQuestion／RequestPermission，不注册模型自报已同意的 GrantPermission。权限目标由服务保存，回应只允许回答／允许拒绝。
2. Observe 流绑定可信 caller，ready 后补 pending；20 秒 heartbeat 对应现有 60 秒 idle，pull source 无无限队列，慢端不阻塞其他端。
3. 接收确认不改变审批业务 revision；有效决定可先于 ack。同 ID 同内容重试返回原结果，其他竞争决定 CONFLICT；决定持久提交后才恢复工具。
4. 关闭单 observer 不拒绝审批；迟到回执不复活；stop／删除／崩溃使请求失效。新 observer 不继承旧投递，服务重启不重放一次性授权。
5. 旧 stop_loop + 另一次用户输入改为明确交互关联属于适配差异，回填 record；按旧会话语义持久保存成功授予的路径范围。

## 独立验收

- cargo test -p xw-agent-runtime／xw-agent／xw-agent-rollout --locked；契约生成／漂移与受影响 addon 构建。
- 两个真实 caller：独立 ack、无需全部 ack 即决定、ack 丢失／重复／跨 caller、审批竞争／重试、旧实例／observer、登记竞态、慢端与 close、重连补 pending；用可控时钟测 heartbeat。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
