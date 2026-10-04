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
