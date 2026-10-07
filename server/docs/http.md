# HTTP 接口

消息结构及错误码语义由 [Proto 契约](../../contracts/proto/xiaowei/server/README.md) 定义；HTTP 状态、路由及限流等传输行为由 Go 的 `internal/httpapi/` 负责。

## 接口总览

当前已实现的全部 HTTP 接口如下，路由定义见 [handler.go](../internal/httpapi/handler.go)。

| 方法 | 路径 | 用途 | 凭据 | 详细说明 |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | 检查进程是否可响应 | 无 | [健康检查](#健康检查) |
| GET | `/readyz` | 检查数据库是否可用 | 无 | [健康检查](#健康检查) |
| POST | `/api/auth/login` | 邮箱密码登录，返回用户、设备和 token | 请求体中的邮箱与密码 | [认证与会话](authentication.md) |
| POST | `/api/auth/refresh` | 轮换 refresh token，签发新的 access token | 请求体中的 refresh token | [认证与会话](authentication.md) |
| GET | `/api/auth/me` | 查询当前用户、设备和会话 | Bearer access token | [认证与会话](authentication.md) |
| POST | `/api/auth/logout` | 撤销当前会话及其全部 token | Bearer access token | [认证与会话](authentication.md) |

Bearer 凭据通过 `Authorization: Bearer <access_token>` 传递。注册、找回密码、第三方登录／绑定和 WebSocket 尚未提供接口。

## 响应约定

**应用生成的响应统一返回 HTTP 200，成功或失败通过响应体的 code 表达。** 这包括解析失败、请求过大、内容类型错误、限流、未登录、参数错误、服务不可用和内部错误；不能直接透传框架默认的 4xx／5xx 响应。

成功返回 `{ code: 0, msg, data }`，失败返回 `{ code: 非零错误码, msg }`。公共与业务错误码都写入 code，说明字段统一为 msg，服务端提供的提示文案使用中文。JSON／协议解码失败由接入层返回 INVALID_REQUEST，解码成功后的业务参数校验失败返回 INVALID_ARGUMENT；具体定义见 [契约文档](../../contracts/proto/xiaowei/server/README.md#接入错误与参数错误)。服务器不认识的新 oneof 分支按解码失败处理。

客户端收到 HTTP 200 仍需检查 code。网络断连、超时或反向代理生成的非 200 响应属于应用外异常，不能假定带有契约消息。服务端日志区分接入和业务失败，对外 msg 不暴露凭据、请求原文或底层错误。

健康探针和应用路由的未知路径／方法错误同样使用该规则。进入 handler 之前的损坏 HTTP 报文由 net/http 处理，不保证带有本应用响应；已断开的连接无法补发响应。

## 健康检查

`GET /healthz` 表示进程可响应，`GET /readyz` 检查数据库是否可用，探测超时为 2 秒。两者均返回 HTTP 200：就绪时 code 为 0、data.status 为 ok；数据库不可用时 code 为 UNAVAILABLE（10008），不带 data。

检查响应体中的 code，不能仅凭 curl -f 的退出状态判断是否就绪。数据库故障不会退出已运行的服务，连接恢复后 readiness 可以恢复。

## 请求限流

通用 IP 限流和接口专用限流的范围、叠加顺序、配置方案与实现状态见 [限流设计](rate-limiting.md)。
