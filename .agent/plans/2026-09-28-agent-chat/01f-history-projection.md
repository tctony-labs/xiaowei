# 01f：历史投影与分页读取

关联 [阶段索引](01-session-contracts.md)、[record](../../records/active/2026-09-28-agent-chat.md)与[控制协议](../../records/active/2026-09-28-agent-chat/control-api.md)。前置是已交付的持久会话与 Run／Item 投影。

## 剩余范围

当前文本历史可重开，ReadSession 和 SubscribeSession 首帧已返回完整保留的 runs／items；快照超过 1 MiB 明确拒绝，不截断。此片补齐大历史有界读取和长 Item 内容读取，继续围绕 Session／Run／Item，移除旧 GetMessages／ReadChanges／公共 view cursor 草案。不新增模型执行、工具或远程 transport，不重做正式 addon。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改 | `contracts/proto/xiaowei/agent.proto` | 在现有 Run／Item 框架补历史分页、明确截断预览与完整内容读取定位；定义分页快照边界及和订阅首帧的衔接，不创建事件续传 cursor |
| 修改 | `crates/xw-agent/src/{service,session,events,recovery}.rs` | 复用现有实时／恢复投影，加入按稳定身份有界读取；分离完整模型历史与客户端分页缓存 |
| 修改 | `crates/xiaowei-agent/src/gateway.rs` | 注册实际新增读取方法，复用同一服务和错误映射 |
| 新增 | `crates/xw-agent/tests/history.rs` | 分页、长内容、追加竞态和跨会话定位测试 |
| 修改 | `crates/xiaowei-agent/napi/test/sessions.test.cjs` | 正式入口读取／重开／订阅衔接验证 |

## 实施顺序与验证

1. 先核对当前完整快照和 Codex 的 Run／Item 分页框架，再确定公共字段；历史页绑定会话及已提交上界，不能把实时事件改为通知后拉取。
2. 以默认 50／最多 100 个历史实体、512 KiB 页预算为起点复核 Run／Item 粒度；长内容每片至多 256 KiB，按 UTF-8 边界读取。预览截断必须可辨认，完整复制可遍历取得，不截断 journal。
3. 工具关联沿用领域身份，只有对应工具生产者交付后才公开工具投影；签名不展示为正文，压缩前原历史保留可读。
4. 验证分页无重复／漏项、追加不改变旧页快照、跨会话定位拒绝、大中文文本可完整拼回、历史读取与实时订阅无缺口。正式 addon 测试不能与同一产物构建并行。

执行相关 cargo test、契约生成／漂移、正式 napi 测试和 just check。完成后回填历史读取及订阅边界，删除本片；不继续拆分。
