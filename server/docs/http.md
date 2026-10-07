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

## 请求日志

日志分为两层：通用 HTTP 层记录每次请求的结果，接口业务层按需要记录业务事件和诊断上下文。两层沿用现有日志机制，客户端为 console／Electron 采集，服务端为 slog。

客户端通用入口位于 `desktop/src/main/http/client.ts`，供小微服务端各业务使用；认证接口在 `services/account/api.ts` 中编码请求、校验业务结果并转换为 AccountError。通用层不依赖 account，不覆盖第三方 LLM／provider 协议。服务端 `internal/httpapi/logging.go` 的中间件覆盖进入应用 handler 的请求，响应写出入口主动标注业务 code，不读取或缓存响应体来获取 code。

每次请求开始时输出一条 `HTTP request started`，包含 method 和安全 path；结束时输出一条 `HTTP request completed`，另外包含 duration_ms、http_status 和 code，不输出加工的 outcome 字段。客户端两条日志都另记录 server origin，使用单行 `key=val` 文本，与服务端默认 slog 文本格式一致；未取得 HTTP 状态或合法业务码时省略对应字段，不用本地产生的错误码替代服务端业务码。HTTP 200 必须结合 code 判断结果。客户端在公共响应解码后记录汇总；认证等业务的数据校验由业务封装负责。

| 日志阶段／请求结果 | 客户端等级 | 服务端等级 |
| --- | --- | --- |
| 请求开始 | debug | info |
| 成功请求结束 | debug | info |
| 业务拒绝、认证失败、参数错误、限流 | warn | warn |
| 服务不可用、内部错误、协议错误、网络或传输异常 | error | error |
| 外部 HTTP 4xx／5xx | warn／error | warn／error |
| 用户主动取消 | debug | 按实际响应或传输结果记录 |

客户端成功日志遵循既有采集策略，正式版默认不输出 debug；服务器所有接口（包括健康检查）的开始及成功结束日志统一使用 info。登录成功、会话刷新和撤销等业务事件继续保留，普通拒绝和限流不重复输出汇总；内部故障可以额外记录安全的错误分类、SQLSTATE 或诊断栈。

### 敏感信息规则

通用层对所有接口使用同一份元信息白名单，不根据 path、业务模块或字段名称选择脱敏规则，不采集整个对象后再递归打码。新增业务接口无需更新通用日志规则。业务层自行选择需要记录的字段，但不能放宽以下要求；所有日志级别及测试凭据同样遵守。

| 信息 | 记录规则 |
| --- | --- |
| 密码、授权码、验证码、邀请码、AT／RT、第三方绑定 token、Cookie、Authorization、API key、数据库凭据 | 不输出值；确需保留字段时整值替换为 `[REDACTED]`，不保留首尾、长度或哈希 |
| 邮箱 | 请求日志不记录；业务事件确需记录时，`@` 前至少 3 个字符则保留首尾各 1 个字符，中间固定为 `***`，否则整个 local part 为 `***`；域名保留，如 `user@example.com` → `u***r@example.com` |
| 公开 user_id、device_id、session_id | 必要业务事件允许原样记录，前提是它们不能作为登录凭据；请求日志不新增这些字段或内部自增用户主键 |
| 昵称、设备名称、客户端 IP | 本次不记录 |
| 服务器地址 | 客户端只记录 origin，即协议、主机和端口，排除 userinfo、基础子路径、query 和 fragment |
| 接口路径 | 客户端由业务代码提供固定路径／路由模板，服务端使用匹配的路由键；未知路径记为 `[unmatched]`，不输出提交的原始路径或查询参数；动态路由使用参数占位符 |
| 请求／响应体、完整 headers、响应 msg、data、原始异常对象或文本 | 不进入请求日志；根据错误类别选择等级，不输出 fetch cause、解码错误原文或 panic 值 |

示例（客户端普通成功请求，均为 debug；服务端开始与成功结束为 info）：

```text
HTTP request started method=GET path=/api/auth/me server=http://127.0.0.1:10001
HTTP request completed method=GET path=/api/auth/me server=http://127.0.0.1:10001 duration_ms=94 http_status=200 code=0
```

开始日志在网络请求／业务 handler 执行之前写出，不包含尚未取得的状态码、业务码或耗时；结束日志沿用结果分级。客户端错误分类仅供内部等级选择和业务封装处理，不输出为日志字段。健康检查使用与其他接口相同的日志等级，没有单独例外。

路径模板只用于展示，不参与敏感信息判断。业务层需要记录邮箱等字段时由业务代码明确处理，通用 HTTP 层不识别这些字段，也不预建任意对象脱敏工具。
