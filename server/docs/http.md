# HTTP 接口

本文维护 HTTP 编解码、响应状态、探针使用和日志规则。方法与消息见 [服务端 proto](../../contracts/proto/xiaowei/server/)，统一寻址与传输支持范围见 [xwapi](../../docs/xwapi.md#方法与登录要求)。

## 接口总览

业务接口使用统一的 POST 短路由，由 [共享 API 注册](../internal/httpapi/api.go) 派生；[HTTP handler](../internal/httpapi/handler.go) 统一解码、鉴权和编码，不按方法另写接入逻辑。`GET /api/ws` 是 [WebSocket 升级入口](websocket.md)，成功返回 HTTP 101，之后使用 WS 帧。

HTTP 接入遵循以下约定：

- 请求体为完整 Request 的 Proto JSON，使用 `Content-Type: application/json`，空消息发送 `{}`；输入 descriptor 为空消息时也接受空请求体。
- 请求体上限 16 KiB，严格按 schema 解码，拒绝未知字段、重复字段和无效 JSON。
- 需要 session 时通过 `Authorization: Bearer <access_token>` 鉴权；不需要 session 的方法仍执行自身的凭据和参数校验。
- 响应使用 Proto JSON 的 snake_case 字段名，int64 按 Proto JSON 规则编码；设置 `Cache-Control: no-store`。

## 响应约定

应用 handler 生成的响应统一使用 HTTP 200，包含未知路径、错误请求方法、解码失败、限流和业务失败；调用方必须按 [契约约定](../../contracts/proto/xiaowei/server/README.md#响应约定) 检查 code，字段和错误码语义不在这里重复定义。

反向代理生成的非 200 响应、损坏 HTTP 报文在进入 handler 前被 net/http 拒绝，以及网络中断，都不保证带有业务响应。进入 WS 后，连接和协议错误也不套用 HTTP 200／JSON 约定。

共享 Rust [HTTP client](../../crates/xw-api/src/http.rs) 禁止重定向，只接受 HTTP 200；读取响应流时累计字节，超过 64 KiB 立即拒绝，不先缓存完整响应。响应必须能按契约解码，预期失败向本地 Gateway 的映射见 [xwapi](../../docs/xwapi.md#http-与-websocket-选择)。

## 健康检查

检查含义、请求／响应类型和失败码由 [Health proto](../../contracts/proto/xiaowei/server/common.proto) 定义，按相同规则推导 POST 路由；没有独立的运维 GET 入口。

容器内 `/xiaowei-healthcheck` 定期直连 Go 的 Ready，部署验收通过 HTTPS 域名请求同一接口，额外验证 Nginx 链路；命令与部署参数见 [部署交付](deployment.md)。Nginx 仅转发，不主动探测。Check 供测试和人工检查，桌面不定时轮询这两个方法。数据库中断时 Go 保持运行，数据库恢复后 Ready 可以恢复成功；HTTP 200 或 curl 成功本身不代表就绪。

## 请求限流

通用 IP 与认证专用额度、可信来源、健康检查豁免及叠加顺序见 [限流设计](rate-limiting.md)。

## 请求日志

客户端使用 console／Electron 采集，服务端使用 slog。通用层只记录安全元信息，业务层按需记录登录、刷新或撤销等事件；普通拒绝和限流不额外重复汇总，内部故障可附带安全错误分类、SQLSTATE 或诊断栈。

每次真实 HTTP 请求记录 `HTTP request started` 和 `HTTP request completed`。字段白名单如下，未取得的状态／业务码省略，不用本地产生的错误码代替服务器结果：

| 范围 | 字段 |
| --- | --- |
| 开始与结束 | `method`、安全 `path` |
| 结束时增加 | `duration_ms`、`http_status`、`code` |
| 客户端增加 | `server`，仅 origin |
| 服务端已匹配业务方法的结束日志增加 | `rpc_method` 完整名、`transport=http` |

客户端在解码和结果校验后记录结束；服务端由响应写出入口标注 code，不读取或缓存响应体获取它。本地鉴权拒绝只记录 `Xwapi request rejected` 及安全方法／原因分类，不产生尚未发生的 HTTP 请求日志。

| 阶段／结果 | 客户端等级 | 服务端等级 |
| --- | --- | --- |
| 开始、成功结束 | debug | info |
| 业务拒绝、认证失败、参数错误、限流 | warn | warn |
| 服务不可用、内部错误、协议错误、网络或传输异常 | error | error |
| 外部 HTTP 4xx／5xx | warn／error | warn／error |
| 主动取消 | debug | 按实际响应或传输结果 |

健康检查沿用相同等级。客户端正式版默认不输出 debug，采集链路见 [桌面日志](../../docs/desktop-logging.md)。

### 敏感信息规则

所有接口、日志级别及测试凭据共用以下边界。通用层使用元信息白名单，不采集对象后再递归脱敏，也不按业务字段识别秘密；业务日志不能放宽这些规则。

| 信息 | 记录规则 |
| --- | --- |
| 密码、授权码、验证码、邀请码、access／refresh token、第三方绑定 token、Cookie、Authorization、API key、数据库凭据 | 不输出值；必须保留字段时整值替换为 `[REDACTED]`，不保留首尾、长度或哈希 |
| 邮箱 | 请求日志不记录；业务事件确需记录时，local part 至少 3 个字符则保留首尾各 1 个字符，中间固定为 `***`，否则整个 local part 为 `***`；域名保留 |
| 公开 user_id、device_id、session_id | 仅必要业务事件允许记录，不能作为凭据；请求日志不新增这些字段或内部数据库主键 |
| 昵称、设备名称、客户端 IP | 不记录 |
| 服务器地址 | 仅 origin，排除 userinfo、基础子路径、query 和 fragment |
| 接口路径 | 仅契约推导的固定路径／匹配的路由键；动态参数使用占位符，未知路径为 `[unmatched]`，不输出原始未知路径或 query |
| 请求／响应体、完整 headers、msg、data、原始异常文本 | 不进入请求日志；不输出 fetch cause、解码错误原文或 panic 值 |
