# 密码登录与设备会话

登录、刷新、当前用户和退出接口见 [HTTP 接口总览](http.md#接口总览)。

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

access token 默认有效期 2 小时；refresh token 默认 30 天，每次成功刷新后重新计时。刷新使旧 refresh token 失效，重复提交只返回凭据无效的业务码，不撤销新凭据；旧 access token 保留到自己的有效期结束。退出立即撤销当前会话的所有凭据，不影响其他设备。服务器重启后未过期、未撤销的会话仍可使用。

当前没有注册或默认测试账号。认证集成测试自行在隔离数据库中准备账号，并通过真实 HTTP 验证上述流程；日常数据库不写入测试账号。已有账号可按契约使用 curl 请求，完整接口语义与限流规则见 [record](../../.agent/records/active/2026-09-25-user-authentication.md#密码登录与设备会话实现)。

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

成功日志为 `administrator initialized`，只包含公开用户 ID；保留成对初始化变量再次启动时记录 `administrator initialization skipped`。日志不输出邮箱、密码或哈希。成功后移除两项环境变量，已有账号仍可通过登录接口正常登录；管理员初始密码不是密码重置机制。

初始化由持有服务器环境和数据库配置的部署者执行，不依赖 SMTP 或邮箱验证码。未填写真实初始化凭据时，不自动创建账号。客户端联调、网页注册、管理后台以及一次性管理员注册 token 均留在后续切片。
