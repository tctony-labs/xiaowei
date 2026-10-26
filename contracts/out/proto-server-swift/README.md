# ProtoServer

服务器 proto 的 Swift 消息包，供 iOS 宿主编解码业务 PB。公开模块为 `ProtoServer`；SwiftProtobuf 生成消息，同次 descriptor 生成服务方法全名常量。不包含网络客户端、gRPC、登录态或存储。

从仓库根执行 `pnpm contracts:generate` 生成，`pnpm contracts:check` 检查漂移，`pnpm contracts:test` 执行包含 Swift 的服务器消息跨语言 codec。不要手改 `Sources/ProtoServer/Generated/`。规则与工具缓存见 [契约生成说明](../../README.md)。

消费者引用本目录的本地 Swift package 与 `ProtoServer` product。包要求 Swift tools 6.2，最低 iOS 17／macOS 14，exact 依赖 SwiftProtobuf 1.39.0；运行库和生成器使用同一版本，解析锁入库。iOS Xcode 工程也显式链接同版本 SwiftProtobuf product，以满足生成消息的运行库符号。

消息与方法语义以[服务器 proto](../../proto/xiaowei/server/README.md)为准。解码成功后仍需检查业务响应 code、消息 presence 和身份关系；错误消息仅供说明，不能用于分支判断。认证 PB 含敏感凭据，不输出到日志或 UI。具体 iOS 保存与调用边界见 [iOS 开发说明](../../../ios/docs/development.md)。
