# 业务契约的创建与维护

这里的 proto 是 TS／Rust 业务通信的唯一手写契约来源。生成方式见 [契约工程](../../README.md)，路由、权限和生命周期见 [Gateway](../../../gateway/README.md)，具体维护步骤见 [maintain-gateway-contract](../../../.agent/skills/maintain-gateway-contract/SKILL.md)。具体接口语义写在 proto 注释中，模块实现与设计取舍写在对应 record 或 docs 中。

## 按业务职责划分

先明确调用方要完成什么、需要哪些信息、结果代表什么，再设计 service 和消息。package 按业务边界命名，同一 package 可以包含多个 proto 文件；service 使用 PascalCase。

不根据 crate、进程、napi 方法、IPC 通道或数据库表机械划分契约。只定义当前需要的能力，真正共用的消息才放入 `common`。

## 消息语义

- 字段名应说明内容；同领域、同含义的消息可以复用，不因标量类型相同就统一包装为 `Text`、`Boolean`、`Count` 等通用消息。
- 响应明确表达操作结果，区分执行是否成功、记录是否存在和操作后的状态。
- 固定集合使用 enum，零值为 `UNSPECIFIED`；执行端拒绝不支持的值。互斥且具有不同 payload 的操作使用 `oneof`。
- `optional` 必须说明缺失的含义，不将缺失、零值和 null 混为一谈。
- 单位、范围、默认值、空结果及错误行为写在字段／方法注释中。时间使用 Unix 毫秒的 `int64 *_at_ms`；ID 的有效范围由对应领域明确。
- Protobuf 类型不能替代业务验证、权限检查和参数限制。

## 契约边界

契约提供调用方所需的业务信息，避免泄漏数据库结构、存储路径等内部实现。摘要与完整内容应明确区分；资源操作由后端根据业务标识解析和执行。

宿主配置、窗口身份、信任级别和 owner 身份不由业务 payload 自行指定。内部 DAO 不作为页面 API；SQL 和迁移由 Storage 内部维护。

## 绑定与调用

路由由 `package.Service.Method` 生成，事件使用 message full name，不手写路由别名。调用方使用生成契约和 typed client，renderer 通过统一 Gateway transport 访问业务能力。

方法和事件由 owner 显式注册。同一 service 分属多个 owner 时，各自只注册负责的方法；绑定方式见 [Gateway 运行机制](../../../docs/gateway-runtime.md#调用与绑定)。禁止两个 owner 发布相同 route，集成测试需覆盖实际调用链。

## 兼容性

已发布字段的编号不得复用，也不得在原编号上替换不兼容类型。删除字段时保留 `reserved` 编号和名称。未发布的同批重设计可以同步切换消费者，不保留无用兼容层。

兼容性由消息语义和 wire 规则决定，生成成功不能代替兼容性验证。
