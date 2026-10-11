# 密码登录与设备会话

登录、刷新、当前用户和退出接口见 [HTTP 接口总览](http.md#接口总览)。

认证业务位于 `internal/auth/`，PostgreSQL 访问与事务位于 `internal/db/`，`internal/httpapi/` 负责协议适配、日志和限流。账号归属、公开用户标识和迁移规则见 [配置、存储与迁移](persistence.md)。注册、找回密码、微信与 WebSocket 尚未实现，后续方案由 [server-development](../../.agent/records/active/2026-10-11-server-development.md) 跟进。

## 登录输入与结果

密码登录请求示例：

```json
{
  "device_id": "550e8400-e29b-41d4-a716-446655440000",
  "device_name": "我的 Mac",
  "password": {
    "email": "user@example.com",
    "password": "..."
  }
}
```

device_id 由客户端首次使用生成并保存在共享数据目录，同一设备的多个安装共用；不是硬件指纹。成功响应位于 data.authenticated，包含 user、device 和 tokens。同一账号同一设备重登会替换旧会话，旧 access／refresh token 均失效，其他设备不受影响。thirdparty_bind_token 已预留但绑定尚未实现，携带时会明确拒绝。

POST 请求使用 `Content-Type: application/json`；logout 允许空请求体。me 和 logout 使用 `Authorization: Bearer <access_token>`。消息定义见 [auth.proto](../../contracts/proto/xiaowei/server/auth.proto)，JSON 字段采用 snake_case，Unix 毫秒时间按 Protobuf JSON 规则输出字符串。

消息结构及错误码语义见 [服务端契约](../../contracts/proto/xiaowei/server/README.md)，HTTP 状态处理见 [HTTP 接口](http.md)。

只有 `data.authenticated` 表示已建立会话，不能仅凭 `code = 0` 保存登录态。`binding_required` 只是预留契约；当前普通密码登录不签发第三方绑定凭据。缺失密码 credential 和显式空 thirdparty_bind_token 为 INVALID_ARGUMENT，非空绑定 token 为 THIRDPARTY_BINDING_UNSUPPORTED；未知字段、重复字段或无法解码的 oneof 为 INVALID_REQUEST。当前实现不会忽略绑定 token 后静默创建普通会话。

邮箱去除首尾空白并转小写，接受不含显示名称的 ASCII 邮箱地址，最多 254 字节；不折叠加号或供应商点号别名。登录密码按原值处理，非空且最多 1024 字节；新管理员密码的设置规则另见下文。device_id 必须是规范小写 UUID v4，device_name 最多 128 字节，必须是有效 UTF-8 且不能包含控制字符。

不存在的邮箱与错误密码统一返回 INVALID_CREDENTIALS（10100）；无效或过期凭据返回 UNAUTHENTICATED（10002），不泄露邮箱是否存在。请求体上限、解码约束和 no-store 响应规则见 [HTTP 接口](http.md)，通用 IP 与认证专用额度见 [请求限流](rate-limiting.md)。

## 密码与凭据存储

密码使用 Argon2id：19 MiB 内存、2 次迭代、并行度 1、16 字节随机盐和 32 字节输出，保存包含算法及参数的编码。校验解析限制编码长度及资源参数，避免异常编码造成过量消耗。不存在的邮箱也执行虚拟密码校验；同时最多计算两个密码哈希，等待校验额度时可以取消。密码不以明文或可逆加密保存。

公开会话 ID 为 `s_` 加 128 位随机值；access／refresh token 分别为 `at_`／`rt_` 加 256 位随机值的无填充 Base64URL 编码，不使用 JWT。服务端严格校验 token 类型和编码，数据库仅保存 SHA-256 哈希；不从 URL 获取认证凭据。日志不记录邮箱、密码、token、验证码或请求体。

## 会话与轮换

access token 默认有效期 2 小时；refresh token 默认 30 天，每次成功刷新后重新计时。刷新使旧 refresh token 失效，重复提交只返回凭据无效的业务码，不撤销新凭据；旧 access token 保留到自己的有效期结束。退出立即撤销当前会话的所有凭据，不影响其他设备。服务器重启后未过期、未撤销的会话仍可使用。

有效期可通过 `auth.access_token_ttl`／`auth.refresh_token_ttl` 配置，对应 env 为 `XIAOWEI_AUTH_ACCESS_TOKEN_TTL`／`XIAOWEI_AUTH_REFRESH_TOKEN_TTL`；必须为正时长且 refresh 长于 access。配置来源优先级见 [配置加载](persistence.md#配置加载)。

同用户同设备登录按设备行锁串行执行，设备名称更新、旧会话撤销和新会话写入同事务提交；失败回滚后保留旧会话，其他设备和账号不受影响。设备 ID 只用于关联，不是认证凭据；退出保留设备记录。

同一 refresh token 的并发刷新只有一次成功。刷新事务替换 refresh hash 并写入新 access token，失败不消费旧 token；重复使用旧 refresh 只拒绝当前请求。退出与刷新对同一会话行的写锁保证刷新不会复活已撤销会话。已完成认证的在途请求不承诺被中途取消。

刷新响应丢失时，已消费的旧 refresh token 不能再次刷新；当前不提供幂等刷新结果缓存，客户端可能需要重新登录。桌面端串行刷新、持久化失败和恢复行为见 [桌面账号](../../desktop/docs/account.md)。密码重置后的全部会话撤销及 WebSocket 失效断连仍在后续范围。

## 存储与事务

| 表 | 职责与约束 |
| --- | --- |
| `email_identities` | 以内部 user_pk 一对一关联用户，邮箱唯一，保存密码哈希 |
| `user_devices` | 以 user_pk + device_id 为主键，保存设备名称和时间；不同账号独立 |
| `auth_sessions` | 关联用户及设备，保存当前 refresh hash、有效期、撤销状态；活动会话唯一索引约束同用户同设备最多一个未撤销会话 |
| `session_access_tokens` | 保存 access hash 和到期时间，关联会话；保留刷新前未过期的 access，删除会话时级联删除 |
| `admin_bootstrap` | 一次性管理员初始化记录，关联用户，与用户及邮箱身份创建同事务提交 |

认证由 access hash、access 到期时间和会话撤销状态共同判断；refresh 是否可用还检查它自己的到期时间。清理遵循下述保留期限，刷新接口不提前删除过期 token。

当前没有注册或默认测试账号。认证集成测试自行在隔离数据库中准备账号，并通过真实 HTTP 验证登录、设备替换、刷新并发与重放、退出、故障与事务回滚；日常数据库不写入测试账号。测试入口见 [服务端测试](../README.md#测试与构建)。

## 认证记录清理

`internal/scheduler/` 使用 Go 标准库管理后台定时任务。认证清理任务在服务启动时执行一次，之后每 24 小时执行；单次最长 1 分钟，同一任务串行执行。失败记日志，下个周期重试，不影响 HTTP 服务启动。服务退出时取消并等待任务结束，再关闭数据库连接。

- 会话从撤销时间与 refresh 到期时间中较早的时刻起，保留 6 个自然月；按 UTC 计算，达到期限后删除，关联 access token 级联删除。
- Access token 从自身过期时刻起保留 7 天，达到期限后删除；刷新接口不提前删除这些记录。旧 access token 在未过期时继续有效。
- 有效会话和有效凭据不删除，用户与设备记录保留。会话中的 refresh hash 在成功刷新时直接覆盖，没有独立的旧 refresh token 历史表。

两类删除在一个数据库事务中执行，失败全部回滚。日志 `authentication records cleaned` 中 `sessions` 为删除会话数，`expired_access_tokens` 为按 7 天规则直接删除的 token 数，不包含会话级联删除的 token。清理按周期执行，记录达到保留期限后可能最多等待一个周期才被删除。

## 首次管理员初始化

管理员是普通用户账号加 `admin` 角色，使用相同的邮箱密码登录和设备会话。目前只实现首次账号初始化；管理后台与管理 API 的权限检查属于后续工作，现有登录响应不新增角色字段。

在 `server/config/.env` 或服务进程环境中同时设置以下变量，将示例邮箱和密码替换为自己的值：

```dotenv
XIAOWEI_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD='your-password'
```

之后通过 `just server` 启动；已运行的开发实例可按 `r` 重启 Go。服务在数据库迁移完成后、监听 HTTP 前初始化管理员。两项均缺失或为空时不执行初始化；只填写一项会报配置错误。进程环境覆盖 YAML 同目录的 `.env`，初始化凭据不支持写入 YAML。

首次初始化将邮箱去除首尾空白并转小写；密码要求 6–32 个可打印 ASCII 字符，允许空格和符号，不支持中文，不强制字符组合，也不修改首尾空白。密码以带独立随机盐的 Argon2id 哈希保存。邮箱或密码格式无效时启动失败；邮箱已属于其他账号时启动失败，不覆盖密码或自动提升账号权限。

用户、邮箱密码身份和一次性初始化记录在同一个数据库事务中创建；并发启动只有一个初始化者能够成功创建，失败会回滚。已有用户的角色默认为 `user`。初始化成功后，即使再次提供不同的邮箱或密码，也不会覆盖原密码或创建第二个管理员；数据库中的初始化记录持续生效，后续修改角色也不会触发重新创建。

成功日志为 `administrator initialized`，只包含公开用户 ID；保留成对初始化变量再次启动时记录 `administrator initialization skipped`。日志不输出邮箱、密码或哈希。初始化后保留两项环境变量及仅首次初始化使用的注释；修改它们不会改变已有账号密码。变量也不代表当前有效登录凭据，管理员初始化不是密码重置机制。

初始化由持有服务器环境和数据库配置的部署者执行，不依赖 SMTP 或邮箱验证码。未填写真实初始化凭据时，不自动创建账号。桌面密码登录已接入；网页注册、管理后台以及一次性管理员注册 token 仍属后续范围。生产初始化、用户验收和明确清库后的重新初始化见 [部署交付](deployment.md)。
