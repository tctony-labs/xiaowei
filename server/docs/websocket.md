# WebSocket 接入

`GET /api/ws` 从同一服务器基础地址升级到 WS／WSS。[WebSocket 接入层](../internal/httpapi/ws/)负责帧、请求执行与资源生命周期；[ConnectionHub](../internal/httpapi/websocket.go) 接入设备会话，由进程装配并关闭。服务端实现对外接口和 HTTP／WebSocket 规范，客户端访问库位于 Rust xw-api。

## 认证与导出

升级后的首个二进制消息必须在 5 秒内提供 access token 和空的客户端 manifest，token 不进入 URL。空 manifest 保留已发布握手格式；声明任何客户端方法或事件均拒绝。认证成功后，服务端公布可调用接口和可订阅通知，调用仍需满足接口的消息契约。

产品网络方法从共享 API 注册与 proto 元信息派生，规则统一见[客户端调用约定](../../docs/xwapi.md#方法与登录要求)。服务端接入层只接收接口调用、订阅和控制请求，并交付响应或通知；不持有客户端接口表，不调用客户端方法或订阅客户端事件。

user、device 和 session 来自服务端验证，不能由业务 payload 覆盖。连接登记后再次鉴权，覆盖认证与撤销并发的窗口；每次调用／心跳前及后台每 5 秒复验 access token。过期、撤销或数据库不可用都会结束连接；认证失效通过安全的 `connection.end` 原因通知客户端。会话撤销与同设备替换只关闭受影响的连接，账号规则见 [认证与会话](authentication.md)。

WS Logout 是退出响应的特殊生命周期：数据库先撤销 session，最终响应实际写入 socket 后再关闭调用连接并释放会话通知。终止期间拒绝新业务调用，周期复验不抢先关闭连接；取消、超时、写失败和关闭同样执行一次性收尾，迟到 handler 注册的通知立即释放。WS 协议层提供请求完成机制，账号规则由 auth 处理。

## 传输与资源限制

一条二进制消息依次包含：4 字节大端 JSON 元数据长度、UTF-8 JSON 元数据、原始 PB payload、可选独立 PB options；不使用 Base64。帧版本为 1，已发布控制／契约版本为 3／1。每条连接使用随机 generation，客户端请求和服务端通知使用独立的 ID 前缀，旧连接的帧不可用于新连接。编解码与契约校验见 [wire.go](../internal/httpapi/ws/wire.go)。

| 边界 | 当前限制 |
| --- | --- |
| 每进程连接 | 256 条，包括等待认证的连接；升级前占用，结束后释放 |
| 单帧 | 元数据 64 KiB、payload 8 MiB、options 64 KiB |
| 每连接请求关联 | 业务 128 项，取消／退订／心跳额外 32 项 |
| 每连接发送缓冲 | 16 MiB |
| 每事件订阅 | 待投递 16 项或 4 MiB，另允许一项正在交付；ordered 溢出关闭连接 |

Go 产品方法未声明业务 options schema，非空 options 明确拒绝；客户端执行选项由客户端访问层消费。方法执行期限、并发及流策略由注册项和握手 manifest 公布，默认值见 [runtime.go](../internal/httpapi/ws/runtime.go)，不在这里维护另一份策略表。

流按 next 逐条 pull，不预读，每流只允许一个 pending next；取消清理有界等待，未完成时明确返回超时。服务端按连接交付通知并等待客户端确认，发布时须按订阅 filter 和会话权限匹配，不提供跨用户广播。取消、超时和断线结束调用方等待，但不合作的 handler／producer 在实际退出前继续占用许可。重连创建新实例，业务方重新建立订阅，不重放请求、事件或流；响应丢失后的幂等与恢复归业务方。

## 部署与验证

[Nginx 模板](../deploy/nginx.example.conf) 为升级入口单独配置 Upgrade／Connection、可信代理头和关闭缓冲；location 自行设置 proxy headers 后不会继承上层头，不能省略 Host／来源头。配置及上线验收见 [部署交付](deployment.md)。客户端心跳、重连与账号恢复归 [桌面云连接](../../desktop/docs/account.md#云连接)，服务端读空闲期限为 45 秒。

进程关闭时，Hub 同时取消等待认证的握手并关闭已认证连接，不能只依赖 `http.Server.Shutdown`。

验证入口：

- [Go 测试](../README.md#测试与构建)：真实数据库上的认证、会话隔离、撤销、退出顺序及关闭清理。
- [Rust／Go WS 回归](../../crates/xw-api/tests/websocket.rs)：隔离 fixture 的 PB、流、事件、取消及队列边界，含 race 检查；fixture 不进入产品二进制。
- [桌面连接回归](../../desktop/tests/main/server-connection.test.ts)：连接切换、失效、默认优先 WS／不可用时使用 HTTP，以及已发出请求不重放的行为。
