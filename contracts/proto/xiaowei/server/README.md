# 服务端契约

本目录定义客户端与 Go 服务端之间的业务契约。生成与消费方式见 [契约工程](../../../README.md)，通用设计规则见 [业务契约](../README.md)。各业务的消息与专用错误枚举放在各自的 proto 中。

## 响应约定

响应中的 `int32 code` 表达处理结果，`code = 0` 表示当前请求步骤处理成功，非零表示失败；是否已建立登录态由具体结果分支决定。`msg` 提供安全的可读说明，客户端不解析文案来判断结果。

业务响应采用平铺的 `{ code, msg, data }`：成功时明确输出 `code: 0`、`msg` 和有具体类型的 `data`；失败只返回 `{ code, msg }`，省略 `data`。无业务数据的成功响应使用 `data: {}`。公共错误和业务错误共用 `code`，不另设业务错误字段。

Proto 不支持消息继承或泛型。各业务 response 分别声明 `code = 1`、`msg = 2` 和具体业务类型的 `data = 3`，不使用 Any，也不嵌套公共结果字段。公共 `ErrorResponse` 只声明前两个字段，其失败 JSON 可直接按具体业务 response 解码。

说明字段统一命名为 `msg`，不使用 `message`；错误码统一放在 `code`，不另设 `error_code` 或 `business_code`。本目录定义消息及错误码语义，具体传输行为由接入实现负责。

### 接入错误与参数错误

| 错误码 | 返回层 | 含义 |
| --- | --- | --- |
| `ERROR_CODE_INVALID_REQUEST = 10000` | 协议接入层 | 请求无法按契约解码，例如 JSON 语法错误、字段类型错误、未知字段、重复字段或多个 oneof 分支。 |
| `ERROR_CODE_INVALID_ARGUMENT = 10001` | 业务参数校验层 | 请求已解码，但字段值不符合要求，例如邮箱格式错误、密码为空或设备 ID 不合法。 |

两者都是跨业务复用的公共错误码。对外 msg 不回显凭据、原始请求或内部错误细节。

错误常量仍通过 proto enum 定义：公共错误放在 `ErrorCode`，业务错误放在各自的枚举中，例如 `AuthErrorCode`。服务端将枚举数值写入 `code`，客户端直接与生成的枚举常量比较，不手写数字或枚举名称字符串。

### 数值范围

| 范围 | 归属 |
| --- | --- |
| `0` | 业务成功，对应公共 `ERROR_CODE_SUCCESS`；业务错误枚举的零值 `UNSPECIFIED` 不作为失败码发送。 |
| `10000–10099` | 公共错误 `ErrorCode`。 |
| `10100–10199` | 认证业务 `AuthErrorCode`。 |

后续业务按 100 个数值分配独立区间，并在此表登记；除零值外，不同枚举之间不得重复使用数值。已发布错误码不得改义或复用。认证的邮箱或密码错误为 `AUTH_ERROR_CODE_INVALID_CREDENTIALS = 10100`，不区分邮箱不存在与密码错误。

### 客户端处理

客户端解码响应后必须检查 `code`，仅 `code = 0` 才读取 `data`。非零码按生成的公共或业务枚举常量处理，未知非零码显示通用失败提示。缺少 code／msg、响应无法解码或成功响应缺少 data 时，作为无效响应处理。

`int32` 不提供枚举类型约束，服务端负责写入有效值。整数承载方式使公共响应不必依赖所有业务枚举，同时让旧客户端能够读取新增错误码并执行兜底逻辑。


## 登录凭据与结果

LoginRequest 的设备字段由所有登录方式共用：device_id 是同一台设备共享的规范小写 UUID v4，device_name 是可空的展示名称。客户端将 ID 持久保存在共享应用数据中，多个安装不分别生成 ID；设备 ID 不是登录凭据。

credential 使用 oneof，目前只支持 PasswordLogin。缺失凭据是 INVALID_ARGUMENT；无法解码的未知分支、重复字段等是 INVALID_REQUEST。未来增加已知登录方式时，未启用的方式使用 LOGIN_METHOD_UNSUPPORTED。

可选 thirdparty_bind_token 缺失表示普通密码登录，显式空字符串为 INVALID_ARGUMENT。目前绑定功能尚未实现，非空值返回 THIRDPARTY_BINDING_UNSUPPORTED，不忽略 token 继续普通登录。后续密码登录或注册可携带该 token，在同一事务内绑定已验证的第三方身份；普通注册不带 token 就不绑定第三方。

LoginResponse.data 为 LoginResult，其 result 必须选择一个分支：

| 分支 | 内容 | 含义 |
| --- | --- | --- |
| authenticated | 用户、设备、access／refresh token | 已建立登录态。 |
| binding_required | thirdparty_bind_token、expires_at_ms | 第三方身份已验证，等待注册新账号或登录已有账号来绑定，尚未建立登录态。 |

thirdparty_bind_token 设计为 15 分钟有效、绑定发起设备、一次性消费的短期凭据，不是 access token。本切片只返回 authenticated；binding_required 仅预留契约，第三方授权和绑定尚未实现。

Rust 使用生成的 Option<enum>，TS 使用带 case 的联合类型；客户端必须处理缺失或未知结果。TS 从 JSON 接收消息时先用 Protobuf-ES fromJson 和对应 schema 解码，不能把普通 JSON 对象直接当成生成的联合类型。

### 认证错误码

| 数值 | 枚举 | 用途 |
| --- | --- | --- |
| 10100 | AUTH_ERROR_CODE_INVALID_CREDENTIALS | 邮箱或密码错误，不区分邮箱是否存在。 |
| 10101 | AUTH_ERROR_CODE_LOGIN_METHOD_UNSUPPORTED | 已识别但未支持的登录方式。 |
| 10102 | AUTH_ERROR_CODE_THIRDPARTY_BINDING_UNSUPPORTED | 第三方绑定能力尚未支持。 |
