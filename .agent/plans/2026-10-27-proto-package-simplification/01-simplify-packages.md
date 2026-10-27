# 简化 Protobuf package 层级

本轮交付实施计划，尚未修改业务契约或消费者。实施范围是 review 全部 proto，去掉包名中与 service、消息名重复且没有独立输出边界的业务路径。

执行时遵循 [契约维护流程](../../skills/maintain-gateway-contract/SKILL.md)、[业务契约规则](../../../contracts/proto/xiaowei/README.md)和 [Rust 开发约定](../../../crates/README.md)。本事项独立使用 Plan，不新建 record。

## 目标与完成标准

- desktop 契约统一使用 `xiaowei.desktop`；server 契约统一使用 `xiaowei.server`。
- 全部 17 份 proto 都有明确的 review 结论；Agent、LLM 和 testing 保留各自已有的独立契约输出边界。
- Rust 模块路径、TS descriptor、Go／Swift 生成类型、Gateway 绑定、HTTP／WS 寻址、健康探针及消费者同步切换。
- 保留当前 service、方法、消息、字段和枚举名称；字段编号、类型、缺失语义、错误码、业务权限和存储格式保持一致。静态检查未发现合包需要解决的名称冲突，因此不顺带重命名类型。
- 生成检查、实际调用链测试和受影响的原生构建通过；文档与当前接口一致，交付时列出未完成验收及其阻塞。

## 全量 review 结论

下表路径相对于 `contracts/proto/`。目前仓库内的全部 proto 均在此表中。

| 文件 | 当前 package | 目标 package／处理 |
| --- | --- | --- |
| `xiaowei/desktop/account.proto` | `xiaowei.desktop.account` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/applications.proto` | `xiaowei.desktop.applications` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/clipboard.proto` | `xiaowei.desktop.clipboard` | 修改为 `xiaowei.desktop`；将限定剪贴板 ID 的 “in this package” 注释改为明确的剪贴板对象范围 |
| `xiaowei/desktop/host.proto` | `xiaowei.desktop.host` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/launcher.proto` | `xiaowei.desktop.launcher` | 修改为 `xiaowei.desktop`；更新 `HighlightRange` 的类型引用 |
| `xiaowei/desktop/search.proto` | `xiaowei.desktop.search` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/session.proto` | `xiaowei.desktop.session` | 修改为 `xiaowei.desktop`；无 service，连接事件也须迁移 |
| `xiaowei/desktop/settings.proto` | `xiaowei.desktop.settings` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/shortcuts.proto` | `xiaowei.desktop.shortcuts` | 修改为 `xiaowei.desktop`；更新 `ShortcutConfiguration` 的类型引用 |
| `xiaowei/desktop/storage/kv.proto` | `xiaowei.desktop.storage` | 修改为 `xiaowei.desktop` |
| `xiaowei/desktop/storage/usage.proto` | `xiaowei.desktop.storage` | 修改为 `xiaowei.desktop` |
| `xiaowei/server/auth.proto` | `xiaowei.server.auth` | 修改为 `xiaowei.server`；免登录选项改为 `(xiaowei.server.api)` |
| `xiaowei/server/common.proto` | `xiaowei.server.common` | 修改为 `xiaowei.server`；扩展 `api` 的全名及其使用位置同步变化 |
| `xiaowei/agent.proto` | `xiaowei.agent` | 保留；已有独立 Rust 输出包 `proto-agent-rs`，没有额外业务子层级 |
| `xiaowei/llm/llm.proto` | `xiaowei.llm` | 保留；已有独立 Rust 输出包 `proto-llm-rs`，没有额外业务子层级 |
| `xiaowei/llm/model-settings.proto` | `xiaowei.llm` | 保留；已与 `llm.proto` 共用 package，无需再增加或删除业务子层级 |
| `testing/fixture.proto` | `testing` | 保留；测试协议独立生成，不进入生产业务注册 |

基于入库 descriptor 静态模拟以上合并，检查了 360 个顶层符号，包括 message、enum、service、extension 和顶层 enum value，未发现重名。实施时仍以 protoc 和实际生成、编译结果为准。

保留 `xiaowei.desktop`、`xiaowei.server`、`xiaowei.agent`、`xiaowei.llm`，依据是它们当前不同的契约输出与消费范围。`contracts/scripts/proto-selection.mjs` 要求同一 package 的所有文件具有相同输出列表；将这些边界继续合成 `xiaowei` 会连带改变现有输出包与依赖组织，本次不做该扩展。

## 实现约定

1. package 与源文件目录解耦。保留现有 proto 文件和目录，包括 `desktop/storage/`；按业务阅读源码不需要再为每个文件增加 package 层级。
2. Rust 消息按 package 合并，公开入口直接提供 `xiaowei::desktop` 与 `xiaowei::server`。消费者更新 import，不新增模仿旧 package 的兼容模块。
3. 合并同一作用域中的模块别名和重复导入。例如 Search 原有 `applications as app`、`host as system`、`search as pb` 将指向同一模块，应整理为一个模块别名或明确的类型导入；server 原有 `auth`／`common` 别名同理。
4. `xw-storage::pb` 是现有公开入口，保留其当前导出的设置／KV／占用统计类型范围，以显式重导出适配新路径，避免机械替换后把整个 desktop 契约全部暴露。
5. TS 和 Go 继续按源文件生成。TS 导出符号、Go import 路径、Go `File_xiaowei_server_auth_proto` 等按文件路径命名的符号保持原样；只更新 descriptor 内的协议身份。不对匹配到 `auth`／`common` 的所有字符串做无差别替换。
6. 现有生成器、输出包、依赖和构建入口足以完成调整；不新增生成规则、路由表、手工别名或兼容转发层。
7. 本次是协议身份变更。采用仓库内完整同步切换，交付时说明旧客户端与新服务器、以及反向组合的不兼容。生产部署和客户端发布不包含在本 Plan 的执行授权内；发布时需要配套版本，不能把 PB 字段兼容等同于路由兼容。

## 关键接口变化

| 位置 | 当前示例 | 调整后示例 |
| --- | --- | --- |
| Rust 桌面类型 | `xiaowei::desktop::account::AccountSnapshot` | `xiaowei::desktop::AccountSnapshot` |
| Rust 服务器类型 | `xiaowei::server::auth::LoginRequest` | `xiaowei::server::LoginRequest` |
| 桌面 RPC | `xiaowei.desktop.account.Account.Get` | `xiaowei.desktop.Account.Get` |
| 桌面事件 | `xiaowei.desktop.session.ConnectionChanged` | `xiaowei.desktop.ConnectionChanged` |
| 服务器本地 RPC | `xiaowei.server.auth.Auth.Login` | `xiaowei.server.Auth.Login` |
| HTTP | `/api/auth.Auth/Login` | `/api/Auth/Login` |
| 健康探针 | `/api/common.Health/Ready` | `/api/Health/Ready` |
| WS `route.name` | `auth.Auth/GetCurrentUser` | `Auth/GetCurrentUser` |
| WS 输出类型 | `xiaowei.server.auth.GetCurrentUserResponse` | `xiaowei.server.GetCurrentUserResponse` |
| 方法扩展 | `xiaowei.server.common.api` | `xiaowei.server.api` |
| Swift 消息 | `Xiaowei_Server_Auth_LoginRequest` | `Xiaowei_Server_LoginRequest` |
| Swift 方法常量 | `Xiaowei_Server_Common_Health.Check` | `Xiaowei_Server_Health.Check` |

依赖方向继续为 proto → 各语言契约产物 → typed client／handler 与业务实现。网络短标识继续从 descriptor 去掉固定 `xiaowei.server.` 前缀推导；现有 Rust／TS／Go 寻址算法已经支持新 package，不增加第二套映射。

## 文件范围

以下为当前源码确认的修改清单。花括号表示逐一列出的文件，实施时按展开后的路径检查。除生成产物外，不新增业务源码文件。

### 契约与公共入口

| 类型 | 文件 | 具体修改 |
| --- | --- | --- |
| 修改 | 上方 review 表中 11 份 desktop proto、2 份 server proto | 按逐文件结论调整 package、跨文件类型引用、方法选项与受影响注释 |
| 修改 | `contracts/out/proto-desktop-rs/src/lib.rs` | `desktop` 内一次 include `gen/xiaowei.desktop.rs`，删除旧业务子模块声明 |
| 修改 | `contracts/out/proto-server-rs/src/lib.rs` | `server` 内一次 include `gen/xiaowei.server.rs`，删除 `auth`／`common` 子模块声明 |
| 修改 | `gateway/rust/business_binding_config.rs` | 更新 server 和 desktop 的 service 全名；保留原模块所依赖的 service 集合及运行时 owner 边界 |
| 修改 | `crates/xw-api/src/contract.rs` | 扩展查找名改为 `xiaowei.server.api`；保留完整 descriptor 解码和默认要求登录的判断 |
| 修改 | `crates/xw-api/src/methods.rs` | 更新 typed 调用中的服务器方法全名，并整理合包后的类型及错误码导入 |

目标 Rust 产物入口结构：

```text
contracts/out/
├── proto-desktop-rs/src/
│   ├── lib.rs                         修改：公开 xiaowei::desktop
│   └── gen/
│       ├── descriptor.bin             重新生成
│       └── xiaowei.desktop.rs         新生成：所有桌面消息
└── proto-server-rs/src/
    ├── lib.rs                         修改：公开 xiaowei::server
    └── gen/
        ├── descriptor.bin             重新生成
        └── xiaowei.server.rs          新生成：所有服务器消息
```

### Rust 手写消费者

以下文件均为修改，限于消息／枚举／嵌套 oneof 的导入路径、生成 Method 模块名及必要的同作用域导入整理。

| 文件 | 具体修改及职责 |
| --- | --- |
| `crates/xiaowei-rust/napi/src/account/mod.rs` | 账号组合层使用合并后的服务器消息与错误枚举 |
| `crates/xiaowei-rust/napi/src/clipboard/mod.rs` | 更新剪贴板事件类型路径 |
| `crates/xiaowei-rust/napi/src/storage/gateway.rs` | 更新设置事件类型路径 |
| `crates/xiaowei-rust/napi/src/xwapi/gateway.rs` | 更新连接事件、BaseResponse 和 Auth／Health Method 模块名 |
| `crates/xw-api/src/lib.rs` | 更新公共服务器错误类型引用 |
| `crates/xw-api/src/account/{types,session,refresh}.rs` | 更新账号消息路径，保留会话行为与检查点语义 |
| `crates/xw-api/tests/{contract,http,ws_requests}.rs` | 更新契约身份、HTTP 路径、WS manifest 与相应断言 |
| `crates/xw-api/tests/account/{session.rs,support/mod.rs}` | 更新账号测试的类型及网络路径 |
| `crates/xw-search/src/gateway.rs` | 合并桌面消息导入并更新生成 Method 模块名 |
| `crates/xw-clipboard/src/{dao,gateway,service,store}.rs` | 更新剪贴板／系统／设置／存储类型和 Method 引用，保留 DAO 与业务 owner 的分工 |
| `crates/xw-clipboard/tests/gateway.rs` | 更新实际跨 owner 调用测试中的类型和 Method 引用 |
| `crates/xw-storage/src/{lib,gateway,clipboard_dao}.rs` | 更新公开 pb 重导出、类型与 Method 引用，维持既有公开类型范围 |
| `crates/xw-storage/src/clipboard_dao/gateway.rs` | 更新剪贴板事件与 DAO Method 引用 |
| `crates/xw-storage/src/settings/{mod,gateway}.rs` | 合并设置／KV／系统类型导入，更新设置事件与 Method 引用 |
| `crates/xw-storage/src/tests/{clipboard_categories,clipboard_search,clipboard_timestamps,settings}.rs` | 更新存储行为测试的类型路径 |
| `crates/xiaowei-mobile/src/{api,lib}.rs` | 更新服务器消息、错误枚举和 API 调用的协议身份 |
| `crates/xiaowei-mobile/examples/binding-fixtures.rs` | 更新生成移动测试样本所用类型路径 |
| `crates/xiaowei-mobile/tests/{api,account,support/mod}.rs` | 更新移动功能测试类型、HTTP 路径与方法全名 |

### Go、桌面测试与移动宿主

| 类型 | 文件 | 具体修改 |
| --- | --- | --- |
| 修改 | `server/cmd/xiaowei-healthcheck/{main,main_test}.go` | 探针与测试同步使用 `/api/Health/Ready` |
| 修改 | `server/cmd/xiaowei-server/{admin_integration_test,auth_integration_test,websocket_integration_test}.go` | 更新真实 HTTP 地址、WS manifest 类型名、短方法名及日志断言 |
| 修改 | `server/internal/httpapi/{api_test,auth_test,handler_test,limiter_test,logging_test,proxy_test,rate_limit_test}.go` | 更新各接入路径及断言，保留默认鉴权、限流、代理与错误行为覆盖 |
| 修改 | `server/internal/httpapi/ws/logging_test.go` | 更新含完整类型名的日志测试素材 |
| 修改 | `server/internal/httpapi/ws/testfixture/auth.go` | Go WS fixture 与其 HTTP 转发目标使用新 Auth 路径 |
| 修改 | `server/deploy/verify.mjs` | 隔离容器验收的登录、会话、刷新、退出与 readiness 地址同步更新 |
| 修改 | `desktop/tests/main/{account-fixture,account.test,http-logging.test,server-connection.test,xwapi.test}.ts` | 更新隔离 HTTP fixture、路径与日志断言；维持真实 Rust addon 接入 |
| 修改 | `crates/xiaowei-mobile/ffi/scripts/binding-fixture.mjs` | 更新 Swift／Kotlin／iOS 共用的 HTTP fixture 路径 |
| 修改 | `crates/xiaowei-mobile/ffi/tests/{swift/Smoke.swift,kotlin/Smoke.kt}` | 更新跨语言调用的方法身份和 WS 类型信息 |
| 修改 | `ios/XiaoWei/App/{AppConfiguration,AppModel}.swift` | 更新样本解码、Health 方法常量、响应和错误类型名称 |
| 修改 | `ios/XiaoWei/Features/Account/AccountSession.swift` | 更新登录表单消息、账号快照解码和错误枚举名称 |
| 修改 | `ios/XiaoWeiTests/{AccountSessionTests,MobileRuntimeTests}.swift` | 更新账号存储与运行时测试的 Swift 类型、RPC 全名及 WS 信息 |
| 修改 | `contracts/tests/swift/Sources/ContractCodec/main.swift` | 使用新 Swift 类型名验证现有服务器消息 codec |

`server/internal/httpapi/api.go` 与 `contracts/out/proto-desktop-ts/src/server-api.ts` 的寻址逻辑已由 descriptor 推导，无需为本次改名改写算法。通过现有 `contracts/out/proto-desktop-ts/test/server-api.test.ts` 和服务器 API 测试验证新寻址及免登录元信息。

### 生成产物

所有产物通过 `just gen` 更新，不手改。以下集合列出预期发生内容变化、新增或删除的文件；生成结果是最终依据。

| 类型 | 文件 | 具体变化 |
| --- | --- | --- |
| 新生成 | `contracts/out/proto-desktop-rs/src/gen/xiaowei.desktop.rs` | 合并桌面消息与枚举，更新 `prost::Name` |
| 删除旧生成文件 | `contracts/out/proto-desktop-rs/src/gen/xiaowei.desktop.{account,applications,clipboard,host,launcher,search,session,settings,storage}.rs` | 被统一桌面产物替代 |
| 新生成 | `contracts/out/proto-server-rs/src/gen/xiaowei.server.rs` | 合并服务器消息、枚举及嵌套 oneof |
| 删除旧生成文件 | `contracts/out/proto-server-rs/src/gen/xiaowei.server.{auth,common}.rs` | 被统一服务器产物替代 |
| 重新生成 | `contracts/out/{proto-desktop-rs,proto-server-rs}/src/gen/descriptor.bin` | 更新 package、类型、service 和方法扩展身份 |
| 重新生成 | `contracts/out/proto-desktop-ts/src/gen/xiaowei/desktop/{account,applications,clipboard,host,launcher,search,session,settings,shortcuts}_pb.ts` | 保留文件与导出符号，更新协议全名与 descriptor |
| 重新生成 | `contracts/out/proto-desktop-ts/src/gen/xiaowei/desktop/storage/{kv,usage}_pb.ts` | 更新 KV／占用统计 descriptor |
| 重新生成 | `contracts/out/proto-desktop-ts/src/gen/xiaowei/server/{auth,common}_pb.ts` | 更新服务器类型、service 与扩展身份 |
| 重新生成 | `contracts/out/proto-server-go/gen/xiaowei/server/{auth,common}.pb.go` | 保留 Go package、路径与文件 descriptor 变量名，更新协议元信息 |
| 重新生成 | `contracts/out/proto-server-swift/Sources/ProtoServer/Generated/xiaowei/server/{auth,common}.pb.swift` | 更新 Swift 类型前缀和协议元信息 |
| 重新生成 | `contracts/out/proto-server-swift/Sources/ProtoServer/Generated/ServerMethods.swift` | 更新 service 常量容器名与方法全名 |
| 重新生成 | `crates/{xiaowei-rust/napi,xw-search,xw-clipboard,xw-storage}/src/gateway_binding.rs` | 更新 Method 模块名、消息路径及完整路由 |

Agent、LLM 与 testing 源契约未改，生成时核对其产物没有无关变化。`proto-desktop-ts/src/index.ts`、各产物包 manifest 和 `contracts/generate.config.json` 保持现有入口与输出选择。

### 规则与当前说明

| 类型 | 文件 | 具体修改 |
| --- | --- | --- |
| 修改 | `contracts/proto/xiaowei/README.md` | package 规则改为稳定契约范围；具体业务由文件与 service 组织，目录不再机械对应 package |
| 修改 | `contracts/README.md` | 修正业务 package 与单／多文件目录的旧约定，保留现有生成机制说明 |
| 修改 | `contracts/proto/xiaowei/server/README.md` | 免登录选项示例改为 `(xiaowei.server.api).no_login` |
| 修改 | `server/README.md` | 更新本地 Check／Ready 示例地址 |
| 修改 | `server/docs/{deployment,persistence,rate-limiting}.md` | 更新当前健康检查与上线验收地址 |
| 修改 | `desktop/docs/account.md` | 更新短网络标识和日志示例 |
| 修改 | `.agent/plans/2026-09-28-agent-chat/02i-webfetch.md` | 仅修正其未来 Settings 变更所引用的 Rust 生成文件路径，保留该计划其余内容 |
| 授权后修改 | `docs/xwapi.md` | 将 Gateway／HTTP／WS 示例同步为新身份；寻址推导规则保持一致 |

根 `AGENTS.md` 明确规定根 `docs/` 的修改需要用户明确授权；当前只授权编写本 Plan，因此此轮不修改 `docs/xwapi.md`，后续实施时在修改该文件前取得授权。根 `README.md` 不改。active record 中已有的实际历史日志保留原貌，archived record 不修改；本次不接管或迁移其他事项。

## 实施顺序与验证

### 1. 契约、公共入口与绑定配置一起切换

- [ ] 开始前重新核对 git 状态、全部 proto 清单及消费者，保留用户已有改动。
- [ ] 按 review 表更新 13 份 proto，保留 import 的文件路径，更新同包类型引用与方法扩展。
- [ ] 更新两个 Rust `lib.rs` 和 `business_binding_config.rs`，再执行 `just gen`。
- [ ] 检查新旧 Rust 生成文件集合、TS／Go 文件路径和 Swift 类型名；确认删除旧文件且没有无关产物变化。
- [ ] 执行 `pnpm contracts:check`、`pnpm gateway:check`。此阶段允许尚未迁移的业务消费者暂时编译失败，但生成和绑定检查必须通过；不运行旧原生产物验证新契约。

### 2. 迁移 Rust 消费者与服务器协议元信息

- [ ] 按文件清单更新类型导入、oneof 路径、Method 模块名、事件类型和硬编码方法身份。
- [ ] 整理合包后重复的模块别名及导入；`xw-storage::pb` 保持原有公开类型范围。
- [ ] 更新 `xw-api` 的方法扩展查找名，确认 Login／Refresh／Check／Ready 仍为免登录 HTTP，GetCurrentUser／Logout 仍要求登录并可经 WS 调用。
- [ ] 更新 Go WS fixture、Rust 测试中的网络标识与 manifest 输入／输出类型。
- [ ] 执行以下相关 Rust 回归，覆盖真实 HTTP／Go WS fixture 与跨模块 Gateway：

```sh
cargo test --locked -p xw-api -p xw-storage -p xw-clipboard -p xw-search -p xiaowei-mobile
```

在既有 `xw-api/tests/contract.rs` 和 API／WS 测试中明确验证新方法全名、短地址、标准 Empty 和方法选项；保留原有成功、失败、取消、超时、刷新检查点与 owner 生命周期覆盖，不另建只复述字符串替换的测试套件。

### 3. 切换服务器、健康探针与桌面完整调用链

- [ ] 更新 Go 和桌面 fixture、测试与日志断言，以及 healthcheck 和部署验收脚本的路径。
- [ ] 执行正式原生包构建；当前实际受影响的是 `xiaowei-rust`，`xiaowei-agent` 没有使用发生变化的 desktop／server 契约，不因生成命令重跑而额外要求重建它：

```sh
pnpm --dir crates/xiaowei-rust/napi build:debug
pnpm --dir desktop test
```

- [ ] 在 `server/` 执行 `go test -race ./...`；数据库用例使用既有专用测试连接和隔离数据库。若缺少 `XIAOWEI_TEST_DATABASE_URL`，报告实际跳过项，不能计为认证／存储集成测试通过。
- [ ] 验证 HTTP 新地址可调用，旧地址不被意外保留为别名；WS manifest 的新 route、PB 类型与客户端一致，免登录方法继续不导出为 WS 能力。
- [ ] 验证健康探针命令和相应单测访问新 Ready 地址，数据库失败仍以业务 code 判失败。更新后的容器验收入口按 `server/docs/deployment.md` 以独立镜像／临时数据执行，不操作生产部署。
- [ ] 核对 Account、Settings、Clipboard 和 ConnectionChanged 等事件仍通过实际 owner 发布与订阅；保存会话可继续恢复，未因名称切换丢失账号或配置。

### 4. Swift／Kotlin 与 iOS 宿主同步

- [ ] 更新 Swift 生成类型消费者、方法常量、Kotlin／Swift smoke 方法名和共用 fixture。
- [ ] 执行 `pnpm contracts:test`，覆盖现有生成选择规则、TS `serverApiMethod` 及 TS／Rust／Go／Swift codec。服务器消息 PB 字节与 Proto JSON 的既有语义应保持一致。
- [ ] 执行 `node crates/xiaowei-mobile/ffi/scripts/verify-bindings.mjs`，验证 Swift／Kotlin 实际调用 Rust 并连通同次契约的隔离 HTTP／WS fixture。
- [ ] 执行 `node ios/scripts/prepare.mjs --configuration Debug`，按 `ios/docs/development.md` 构建模拟器 App，确认 Swift 类型和方法名替换完整。
- [ ] 选择现有可用模拟器 destination，执行 `ios/scripts/verify-runtime.mjs` 的隔离运行验证，覆盖账号恢复和请求边界。改名验收使用本次构建的测试服务，不把尚未升级的线上服务失败误判为实现故障。

### 5. 文档、最终检查与收尾

- [ ] 更新已授权的包内规则与当前说明；取得根 `docs/` 授权后同步 `docs/xwapi.md`。旧实际日志和归档历史不做文本替换。
- [ ] 对当前源码、配置、生成产物和测试搜索旧业务 package、Rust 业务子模块、旧 Method 模块及旧 HTTP／WS 标识；逐条排除按源文件命名的 Go descriptor 变量、历史记录与刻意保留的旧地址拒绝断言。
- [ ] 执行 `just check`；最终重新确认契约与 Gateway 漂移检查通过。
- [ ] 桌面现场验证遵循实例管理规则：只有确认当前工作区已有实例才能 `just rs`；没有实例时完成原生构建和自动化测试，列明待用户启动后验证的事项，不冷启动 Electron。
- [ ] 报告实际生成变化、测试结果、必要验收的阻塞和新旧客户端／服务器兼容边界。不执行提交、发布或生产部署。
- [ ] 所有完成标准满足后，把需要保留的规则放在上述包内文档，向用户报告结果，再删除本 Plan 和空目录；不为收尾新建 record。

## 当前检查点

- 已枚举并 review 全部 17 份 proto。
- 已对入库 descriptor 做合包后的顶层符号冲突检查，未发现冲突；尚未执行修改后的代码生成或测试。
- 已确认 Rust 按 package 合并文件，TS／Go 按源文件保留路径，Swift 类型前缀随 package 变化。
- 已确认服务器方法扩展、HTTP／WS 身份、健康探针、移动端和测试 fixture 都需要同步，不能只改 proto 声明。
- 当前仅创建本 Plan；实施任务全部待执行。
