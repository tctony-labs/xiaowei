# xwapi 服务与服务器调用

## Why

整理前客户端将通用 HTTP 传输放在 `desktop/src/main/http/client.ts`，认证接口封装放在 `desktop/src/main/services/account/api.ts`。当时这些调用由 TS 账号模块直接使用，其他语言的业务模块缺少统一的服务器调用入口。

用户要求整理为 xwapi service，经 Gateway 提供强类型方法，并在本地统一检查登录态，避免未登录请求发送到服务器。2026-10-07 用户进一步确认：未来业务方可以选择 HTTP 短连接或 WebSocket 长连接发送请求；WebSocket 仅在登录后建立，本轮不实现，但需要记录并保留合理的模块边界。

本事项承接[账号与登录](../active/2026-09-25-user-authentication.md)中的客户端服务器调用封装；账号产品流程、会话持久化与服务端认证规则继续由原事项维护。远端通信基础约束沿用 [Gateway 的 WebSocket 设计](../../../docs/gateway.md#远端服务与双向-websocket尚未实现)。

## What

- 将客户端服务器 HTTP 传输与 API 封装整理到 `desktop/src/main/services/xwapi/`，复用现有 Gateway，支持 TS 与 Rust 等消费者。
- 对外提供强类型方法，复用 `contracts/proto/xiaowei/server/auth.proto` 的请求、响应及 service，不新增一套重复的认证消息，也不使用任意路径加 JSON 的通用请求入口。
- 纳入现有四个认证接口和两个健康检查接口；为健康检查补充必要的 RPC 声明，响应复用 BaseResponse，输入复用 Empty。
- xwapi 内通过硬编码方法配置管理认证要求：默认需要登录，仅明确声明的方法免除普通登录态检查。
- 需要登录的方法在发送前检查本地会话；未登录或已明确失效时快速返回 UNAUTHENTICATED，不发送 HTTP 请求。
- 保留现有账号登录、凭据保存、恢复、自动刷新、取消登录及退出清理语义。
- WebSocket 仅记录后续方向，本轮不实现连接、心跳、重连、网络帧协议或服务端 WebSocket 接入。

完成标准：真实 Gateway 调用覆盖强类型编解码、本地拒绝且网络请求数为零、免登录方法、有效会话携带凭据、健康检查结果及错误传播；既有账号行为回归通过。涉及 Rust 生成产物时完成对应原生构建和跨语言验证。实现与验证结果见 Outcome。

## How

当前模块职责、强类型接口、本地登录检查、健康响应、关闭行为及后续 HTTP／WebSocket 选择统一维护在 [xwapi 服务器调用](../../../docs/xwapi.md)。账号会话持久化和产品登录流程继续由 [账号事项](../active/2026-09-25-user-authentication.md) 维护。

用户明确选择强类型方法、硬编码免登录配置，以及“xwapi 只转发，由调用方管理会话”。因此复用 server proto 和现有 Gateway，不建立通用路径／JSON 入口，不在原始 Login／Refresh／Logout 中自动修改 Account 状态。Account 内部事务复用同一无状态执行器，并提供自己持有的上下文，保持迟到取消补偿和凭据轮换边界。

健康检查复用 Empty 和公共 BaseResponse，不创建同形 HealthCheckResponse；ErrorResponse 重命名改变了生成 API 与消息全名，但 code/msg 字段编号和 JSON 未改变。当前使用 TS main 异步 HTTP；未因未测量的性能差异新增 Rust 实现或 worker。后续 WebSocket 必须登录后建立，业务方可选择传输的要求已保留在长期文档，本轮不实现占位 transport。

## Alternatives considered

- 通用 HTTP 请求入口：用户已选择强类型方法；现有认证 proto 已提供契约，通用路径和 JSON 入口会失去相应类型约束。
- 逐接口显式要求登录：采用默认要求登录、少数方法免登录，避免未来新增接口因漏配而绕过本地检查。
- 本轮实现 WebSocket：用户明确暂不实现；先记录选择能力和认证边界，不为未来传输引入额外运行时或空抽象。

## Outcome

2026-10-07 用户确认 feature 验收通过并授权归档。HTTP／Gateway 原实施范围完成，Plan 已删除；当前说明迁入 [xwapi 长期文档](../../../docs/xwapi.md)。本记录保留取舍及验收证据，xwapi 功能继续生效。WebSocket 选择与连接管理是明确拆出的后续范围，尚未实现。

HTTP/Gateway 切片已实现：请求代码集中到 xwapi，经现有 Auth 及新增 Health service 暴露六个强类型方法；默认检查本地 access 会话，四个方法显式免登录。ErrorResponse 已重命名为 BaseResponse，同步三语言产物和 Go 引用。xwapi 原始认证调用不修改 Account 会话，原账号产品流程仍负责保存、刷新、恢复和退出。TS main 执行位置及后续 WebSocket 选择和登录边界已提取到长期文档，未实现 WebSocket。

验证通过 `just gen`、`just check`（含契约与 Gateway 漂移检查）、`pnpm contracts:test`、`pnpm build:rust`、完整 `pnpm --dir desktop test` 及 `cd server && go test ./internal/httpapi`。desktop 包含 45 项 main 测试、新增 Rust napi 跨语言用例和其余桌面回归；三语言 codec 验证契约编解码。真实本地 HTTP 与 Gateway 测试确认未登录、缺少凭据、到期边界和服务器不匹配时网络请求数为零，免登录不附 bearer，健康检查以 code 判定，原始认证方法不保存/替换/清除 Account 文件或快照。账号迟到取消补偿、自动刷新合并、轮换后保存失败、退出与恢复继续通过；owner 关闭取消并等待真实在途 HTTP，fixture 构建窗口结束恢复正式 addon。

首次全仓检查与原生构建重叠时扫描到 napi 构建的临时事务 JSON，构建结束后重跑已通过；只保留既有 Select.tsx 的 Biome 信息提示，未调整无关代码。模块 README、原认证 record 与服务器 HTTP 文档已同步，本切片 Plan 已删除。

自动验收阶段 hermes 没有运行桌面实例，当时运行进程属于 oracle，未冷启动或操作其他工作区。本切片行为已通过 Gateway/HTTP/文件和启动生命周期自动验收。

用户启动 hermes 后，2026-10-07 20:51 的现场启动恢复验收通过：Electron PID 34013 与 nodemon PID 33550 的绝对命令路径、cwd 和父子链均属于 hermes，五个已加载 .node 均来自该工作区，main 构建时间为 20:51:26，晚于本次源码修改。当天活动日志第 986、989 行分别在 20:51:30.092／20:51:30.162 记录 services/xwapi/http.ts 的 GET /api/auth/me 开始与结束，HTTP 200、code 0、耗时 71 ms；auth.json 修改时间为 20:51:30，启动窗口内无错误或警告。实例已加载本次改动，本次仅只读核对进程、已加载模块、文件时间与安全日志，没有再次触发重启、读取 token 或退出用户会话。原始 API、鉴权拒绝和健康检查的跨语言行为沿用自动回归证据，不将恢复请求误称为现场覆盖全部 Gateway 方法。未提交。

用户自行退出并重新登录后的现场日志验收通过：2026-10-07 当天活动日志第 1005–1007 行在 20:56:14.959–20:56:14.970 记录 xwapi POST /api/auth/logout（HTTP 200、code 0、10 ms）及 Account signed out；第 1008–1010 行在 20:56:23.237–20:56:23.285 记录 xwapi POST /api/auth/login（HTTP 200、code 0、47 ms）及 Account signed in。20:56 起当天活动和轮转日志无 warn/error，auth.json 修改时间与本次登录一致。请求日志仅含约定元信息，没有请求体、密码、token 或响应正文；账号业务事件单独记录。Agent 只读核对，不发起登录或退出。
