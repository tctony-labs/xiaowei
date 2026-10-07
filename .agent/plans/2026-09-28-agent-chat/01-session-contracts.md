# 01：剩余历史读取

关联 [record](../../records/active/2026-09-28-agent-chat.md) 与[总实施顺序](00-implementation-order.md)。领域类型、文件提交／恢复、SQLite 会话管理、快照同步及正式 napi 已交付，不再列为待实现。

本阶段仅保留 [01f：历史投影与分页读取](01f-history-projection.md)。当前 ReadSession(include_runs=true)／SubscribeSession 首帧已经返回完整文本 Run／Item 投影；剩余范围是超过当前编码预算的大历史与长内容读取，不重新定义消息主链路或事件 cursor。

01f 完成后，03a 接入历史分页 UI；工具循环可基于当前小会话实现独立推进。新增工具／Interaction 的投影与事件随 02e／02f 落地，正式 Gateway／napi 检查由对应片负责，不保留独立的重复接线计划。

长期接口、包边界和存储字段分别见 record 的[架构](../../records/active/2026-09-28-agent-chat/architecture.md)、[控制协议](../../records/active/2026-09-28-agent-chat/control-api.md)与[历史格式](../../records/active/2026-09-28-agent-chat/history-format.md)。01f 结束后删除本索引。
