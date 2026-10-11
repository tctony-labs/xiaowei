# 用户、注册与登录方案

## Why

用户于 2026-09-25 要求开始讨论并记录用户与登录实现方案。登录后的业务通信使用 WebSocket；需要考虑邮箱注册／登录、中国用户使用微信登录的便利性，以及第三方自行部署服务器、客户端配置服务器地址的完整流程。

此前[设置窗口事项](../active/2026-09-18-settings-ui-inventory.md)暂缓账号与云连接，仅保留模拟 UI；[Gateway 远端设计](../../../docs/gateway.md#远端服务与双向-websocket尚未实现)记录了远端双向 WebSocket、连接认证与会话授权边界。本事项从服务端存储基础开始推进，桌面账号 UI 与远端通信仍按各自后续切片实施。

## What

以下保留原事项范围；归档是按已完成与未完成内容拆分，不表示全部目标均已实现。

已明确的需求：

- 登录后通过 WebSocket 与服务器通信。
- 先做邮箱注册与登录；微信作为第三方登录身份绑定到已有账号。本轮只考虑邮箱与微信，不设计 Facebook、WhatsApp 等其他接入。
- 用户明确要求设置密码，日常使用邮箱加密码登录，不采用每次通过邮箱验证码登录的方案。
- 用户表使用内部自增主键 `id`，对外使用独立生成的随机 `user_id`，两者保存在同一条用户记录中。
- 服务端默认 HTTP 端口为 `10001`；本地监听 `127.0.0.1:10001`，容器监听 `0.0.0.0:10001`，Compose 对宿主机映射 `127.0.0.1:10001`。PostgreSQL 端口仍为 5432。
- 服务端以 YAML 文件为主配置，部分字段支持明确的环境变量覆盖，方便测试与临时调整；不自动让所有字段可覆盖。
- 第一版统一使用标准 SMTP 发信，不接服务商专用 HTTP 发信 API。SMTP 凭据由测试或服务器部署环境提供，不进入客户端或版本库。
- 支持他人自行部署服务器，客户端可配置服务器地址。
- 服务端最终以 Docker 镜像形式交付部署，数据库采用 PostgreSQL；应用与数据库在同一主机分容器运行。
- 不使用 SQLite，第一版仅考虑单机部署，不设计多机部署能力。
- 各服务器账号独立；注册支持开放、邀请和关闭三种策略，自部署默认邀请注册。
- 客户端首次服务器列表为空，由用户添加并选择地址，第一版同时只连接一个服务器。
- 自动保持登录，支持多设备；退出撤销当前会话，重置密码撤销全部会话。
- 管理员与普通用户复用账号和登录体系；先通过服务端环境变量一次性创建首个管理员，管理后台及初始化注册 token 留作后续工作。
- 实施顺序为先完成邮箱注册、密码登录与找回密码，再接入微信绑定和登录。
- 提前考虑身份归属、部署依赖、服务器切换与会话隔离。

用户于 2026-09-26 确认 PostgreSQL，并通过 plan-align 对齐实施；切片 01、02、02B 与 02A 已完成，切片 07 的当前密码登录版本交付能力已提前实现；SMTP、注册、找回密码、WS 和微信仍属后续范围。未完成的范围及已确认方案已转交 [server-development](../active/2026-10-11-server-development.md)。

用户明确收藏问题先不考虑；收藏上传、同步与迁移不在本轮讨论或实施范围内，不在此预先决定切换账号后的收藏处理行为。

## How

已实现内容以当前代码和长期文档为准，本 record 不再维护运行说明：

| 内容 | 长期文档 |
| --- | --- |
| 配置优先级、用户标识、PostgreSQL 与迁移 | [配置、存储与迁移](../../../server/docs/persistence.md) |
| 密码登录、设备会话、轮换、初始化与清理 | [认证](../../../server/docs/authentication.md) |
| HTTP 响应、日志和限流 | [HTTP 接口](../../../server/docs/http.md)、[请求限流](../../../server/docs/rate-limiting.md) |
| 桌面服务器选择、设备与登录态持久化、恢复及退出 | [桌面账号](../../../desktop/docs/account.md) |
| Gateway 上的 typed API 和网络传输边界 | [xwapi](../../../docs/xwapi.md) |
| 镜像发布、配置检查、部署与配套备份回滚 | [部署交付](../../../server/docs/deployment.md)、[depoly-server](../../skills/depoly-server/SKILL.md) |

关键取舍保留：服务器账号彼此独立；内部自增 ID 与随机公开 ID 分离；密码登录采用 Argon2id 和数据库持久的随机 access／refresh token；同用户同设备重登替换旧会话，其他设备隔离。桌面会话由 Account 管理，普通 JSON 私有文件保存凭据，xwapi 不接管会话。部署使用手动发布的不可变版本和单份升级前回滚备份。

SMTP、注册与找回密码、WebSocket／远端 Gateway、管理能力及微信的已确认方案和未决项统一移至 [server-development](../active/2026-10-11-server-development.md)，不再依据本归档事项推进重大改动。

## Alternatives considered

- 官方统一账号覆盖所有自部署服务器：跨服务器体验可能更一致，但增加中心依赖、第三方服务器信任与账号授权问题，已确认使用独立账号体系。
- 微信作为唯一注册入口：对中国用户方便，但微信接入资格和配置会成为自部署的前置条件，初步建议作为可选项。
- 无密码的邮箱验证码登录：用户明确认为每次收邮件过于麻烦，已选择邮箱加密码登录。邮件验证码仅用于注册验证、密码重置等身份验证操作。

## Outcome

2026-10-11 按用户明确指令归档并拆分。已完成 01 服务端配置与持久化、02 密码登录与设备会话、02B 首次管理员初始化、02A 桌面账号，以及 07 当前密码登录版本的交付能力，另完成限流、认证记录清理和通用 HTTP 日志。未完成的 03–06、07 完整邮箱版本验收、08 及未排期管理能力由 [server-development](../active/2026-10-11-server-development.md) 承接，不能将此次归档解释为完整邮箱／微信版本已经交付。

完成内容已按包边界沉淀到上表文档，移除了过时的当前说明；原事项没有剩余实施 Plan。本文保留历史理由和下述历史验收证据，不记录例行部署流水，也不作为当前配置、实现状态或线上数据的依据。下述曾经的“未提交”“待重启”等描述属于各阶段历史。


切片 01 已通过 Go 单测、race、vet、CGO=0 构建及 just check；真实 PostgreSQL 验证了并发迁移、失败回滚、校验和漂移拒绝、唯一约束与公开 ID 冲突重试。linux/arm64 应用镜像已实际构建，验证本机 Go + Docker 数据库、完整容器内部连接、nonroot 启动、独立重建 server 不重启 db、数据库中断 readiness 503 与恢复、容器组重建保留数据，以及 pg_dump／pg_restore 后用户及 identity 保留。最终 PG 环境隔离变更已通过 race 复验、镜像重建和实际开发 Compose 入口验收，确认 PGSERVICE／PGSSLMODE 不干扰 YAML 配置。测试资源已清理；rebase 后文档按 develop 的最新边界调整，工作区概要未追加内部细节，切片 01 完成。

统一配置与目录收尾已完成：Go 使用 YAML 同目录的可选 .env，外部进程 env 优先，覆盖与空值语义经单测验证；Compose 的统一密码、用户名与库名及外部 env／显式空值经静态解析验证。迁移后的开发 Compose 入口实际启动仅 db，真实 PostgreSQL race 测试通过，实际 just server 入口读取默认 YAML 与同目录 .env、在 PG 干扰环境下正常启动并优雅退出。新 Dockerfile／Compose 构建和 nonroot readiness 通过，含 $／# 的单引号密码在本机和容器中均可用，独立重建 server 不重启 db，构建阶段确认整个 config 目录未进入镜像。Go race、vet、CGO=0 构建与 just check 均通过；已有 deploy/.env 已保留值迁移，本次隔离容器、数据卷和镜像已清理。

本地开发 Compose 独立定义全部依赖，不包含小微 server；just prepare-server 启动完整清单。已验证缺少应用 YAML 或镜像引用时也能启动，重复执行复用同一数据库容器。部署流程与命令说明按用户要求移除，部署交付仅保留待定 TODO，相关方案后续再对齐。

本地开发入口已改为 just prepare-server 与 just server，scripts/dev/server.mjs 提供终端 r／R／h／Ctrl+C，复用现有进程组清理，不增加第三方依赖。9 项新增测试覆盖缺失配置提示、配置文件存在时直接交给 Docker 启动及启动失败传播、大小重启顺序、退出取消、失败重试、清理失败与非 TTY；全部 42 项开发工具测试及 just check 通过。隔离目录、独立 Compose project 与真实 PostgreSQL／Go 服务经实际 just 入口和伪终端验证：prepare-server 缺失文件时输出对应 cp 命令；just server 自动准备并达到 readiness；r 保持数据库容器，R 更换容器但数据卷与测试数据保留；早期 Ctrl+C 验证 Go 进程消失而数据库仍在；退出行为现按用户要求改为同时停止依赖并保留数据。按用户要求移除 .env 内容预检查后，9 项脚本测试复验通过；实际 just server 入口验证空密码由 Docker Compose up 报错，准备失败时不会启动 Go。临时验收目录、容器与数据卷已清理，部署交付仍仅保留 TODO。

按用户要求将 Go internal/storage 改名为 internal/db，并同步包名、入口引用、文件名与现有说明；仅改变命名，迁移 SQL 与数据库结构未变。Go race 测试、vet、独立 PostgreSQL 上的 db race 集成测试及 just check 通过，旧 Go 模块引用已清除，隔离数据库容器已删除。

迁移已改为 UTC 时间戳与 bigint 历史版本，未知迁移保留并提示，合并后较早的未执行迁移可补执行，已知校验和不匹配仍拒绝。原 users SQL 逐字节保持。真实 PostgreSQL race 测试覆盖新分支增加表、可空及有默认值字段后旧代码读写、较早迁移补执行、重复执行、不可兼容字段删除在业务调用时报错、时间戳冲突／格式拒绝。实际 Go 二进制启动验证未知迁移下 HTTP readiness 正常和日志提示、已知 SQL 被改动时退出；Go race、CGO=0 构建和 just check 通过，临时验收资源已清理。

按用户要求，开发期旧序号数据库改为本地一次性处理，删除运行时代码中的旧版本转换、字段类型升级及对应测试。本地 xiaowei-dev 数据库的版本 1 已在事务与迁移锁内转换为 20260925000000，历史字段改为 bigint；处理前后校验和、原执行时间和用户数据摘要一致，用户记录仍为 0 条。

开发实例退出已联动 Compose stop：先等待 Go 进程组退出，再停止同一依赖项目，保留容器与数据卷。11 项服务端启动脚本测试及全部 44 项开发工具测试通过，涵盖 Ctrl+C／SIGTERM 的清理顺序、重复停止和 Docker 停止失败；Go race（含真实 PostgreSQL 迁移测试）与 just check 通过。实际 just server 终端验收确认 Go 先退出、依赖容器停止且数据卷保留，just prepare-server 重新启动同一容器并读取原测试数据。验收脚本首次重新准备遗漏隔离环境，短暂重建本地共享容器；已恢复仓库原配置、127.0.0.1:5432 与原数据卷，并核对迁移记录和用户数量未变化。修正后的隔离验收通过，临时目录、脚本、容器与数据卷已清理。

切片 02 已实现 Argon2id 邮箱密码登录、随机 access／refresh token、持久化多设备会话和四个 HTTP 接口，契约通过现有生成流程输出三语言消息。默认 access 2 小时、refresh 30 天且刷新续期；旧 refresh 拒绝不撤销新凭据，旧 access 保留到期，退出仅撤销当前会话。没有增加注册绕过、默认账号、JWT、Redis、Web 框架或桌面账号实现。

专用 PostgreSQL 上的完整 Go race 测试通过，包含邮箱唯一约束、创建／刷新失败回滚、并发刷新只成功一次、旧凭据重试不影响新凭据、旧 access 保留、有效期边界、退出／刷新竞争和多设备隔离。实际 main 服务通过真实 TCP HTTP 验证正误密码和不存在邮箱统一响应、限流及 Retry-After、数据库故障 503 与恢复、凭据类型隔离、重启后的会话恢复，以及错误响应和日志不泄漏秘密。独立 CGO=0 二进制另经 curl 验证同样的登录、刷新、并发、退出与重启闭环，fixture 与数据库均隔离于日常开发环境。

just check（含 Go vet）、两项契约漂移检查、三语言 codec、受影响原生模块重建及桌面回归测试均通过；只存在既有 Select.tsx 的 Biome 信息提示。密码哈希基准在本机 Apple M4 Pro 上约 18.5 毫秒／次、分配约 19 MiB，同步校验上限为两次。接入本地 Go 契约后同步修复 Dockerfile 构建依赖及上下文允许列表，镜像实际构建成功，nonroot 用户 65532 下 readiness、登录与当前用户查询通过；部署流程仍保持 TODO。临时验收资源已清理，日常数据库未写入测试账号。

服务端 proto 已按用户要求集中到 xiaowei/server/，Go 使用目录通配自动选择，公共 import 继续自动生成。同步了 TS 导出、Go 认证与公共消息的独立导入和现有文档；Protobuf 包名、服务名及字段未改变。just gen、两项漂移检查、三语言 codec、Go 单测、just check 与原生模块重建通过；本次仅调整契约路径，未重复运行真实数据库验收。

错误响应已同步为单一整数 code，移除 business_code；公共码从 10000 起，每个模块分配 100 个数值，客户端使用生成枚举常量。协议重新生成及漂移检查、just check、三语言 codec、Rust 原生构建和隔离 PostgreSQL 上完整 Go race 测试均通过；HTTP 错误测试确认 JSON 中 code 为数字。

认证 package 已调整为 xiaowei.server.auth，Rust 导出同步为 xiaowei::server::auth，旧生成文件已移除；HTTP 路径和 Go import 路径不变。重新生成、just check、三语言 codec、Go 单元测试与 Rust 原生构建通过；本次未重跑依赖 PostgreSQL 的集成测试。

认证响应已统一为 code、msg 和具体业务类型的 data：成功明确输出 code = 0，业务失败使用 HTTP 200 并省略 data；当时 HTTP 请求解码、限流和服务故障仍使用对应 HTTP 错误状态；该设计已被统一 HTTP 200 约定取代，并在本次补充实现中完成同步。Proto 无继承，各 response 显式声明公共字段。公共 package 为 xiaowei.server.common。重新生成与漂移检查、just check、三语言 codec 和 Rust 原生构建通过；隔离 PostgreSQL 上完整 Go race 测试通过，实际 HTTP 验证成功数据、失败无数据、错误凭据、会话重放、并发刷新按业务码判断、限流及数据库故障。

用户再次明确：应用生成的 HTTP 响应统一为 200，成功和错误只由 code 表达，说明字段为 msg。接入解析错误 INVALID_REQUEST 与业务参数错误 INVALID_ARGUMENT 分别归属接入层和业务校验层。HTTP 状态规则维护在 server/docs/http.md，由 Go internal/httpapi 接入层落实；contracts/proto/xiaowei/server/README.md 只维护消息结构和错误码语义。本次仅同步文档并标注实现差异，没有修改协议或运行代码，也未运行功能测试。

已只读核对本地 xiaowei-dev 数据库的 schema_migrations，仅有 20260925000000；auth 与 devices 尚未执行。按用户要求合并为 20261003143154_auth.sql，一次创建设备及完整会话结构，删除独立 devices 迁移、embed 登记和历史会话过渡 SQL；未改动日常数据库结构或数据，临时启动的本地数据库已恢复停止状态。隔离 PostgreSQL 上完整 Go race 测试通过，涵盖迁移与会话、实际 HTTP 登录及刷新流程；当时设备 UUID 与登录 oneof 尚待实施，现已在下述补充实现中完成。


切片 02 补充实现完成：LoginRequest 使用密码 credential oneof 和可选 thirdparty_bind_token，LoginResponse.data 使用 authenticated／binding_required result oneof。密码登录返回 authenticated；缺失凭据和空绑定 token 为 INVALID_ARGUMENT，未知字段等解码失败为 INVALID_REQUEST，非空绑定 token 返回 THIRDPARTY_BINDING_UNSUPPORTED，不访问绑定功能或更改会话。第三方授权、注册和绑定仅预留协议，未声称已实现。

合并的 auth 迁移使用 UUID v4 用户设备记录及活动会话唯一索引。设备行锁将同用户同设备登录串行化，更新设备名称、撤销旧会话与新 token 写入在同一事务完成；回滚保留原会话和名称，刷新竞争不会复活旧会话，其他设备及账号隔离。日常数据库仍未执行 auth 迁移。

Go HTTP 接入的解析、认证、限流、未知路径、错误方法、非规范路径、健康探针及未写响应前的 panic 统一返回 HTTP 200 和 code／msg；就绪检查读取 code，不能仅凭状态码判断。HTTP 规则在 server/docs/http.md，消息和错误码语义在 contracts 服务端 README；Proto 不定义 HTTP 行为。路由使用明确路径映射，避免标准 ServeMux 的默认重定向与错误正文绕过约定；未引入框架。

验证通过：just check（含 Go vet、两项生成漂移检查）、pnpm contracts:test、pnpm build:rust，以及隔离 PostgreSQL 上完整 go test -race ./...。三语言实际登录契约往返覆盖密码 oneof、authenticated／binding_required、可选 token 缺失与空值，TS fromJson 验证结果分支及重复分支拒绝。真实 HTTP 覆盖绑定 token 拒绝不改会话、密码错误不撤销、同设备重登、旧 token 失效、不同设备保持登录、刷新重放、限流与数据库故障恢复；数据库测试覆盖从 users 升级合并迁移、幂等、必填 UUID、并发登录、回滚及重登／刷新竞争。既有 Select.tsx 仅有 Biome 信息提示。测试数据库与容器清理，未启动 Electron，未提交。

用户启动当前工作区实例后的现场验收通过：确认进程 cwd 为本工作区 server，本地 schema_migrations 已有 users 和合并 auth 迁移。对 10001 端口实际请求验证 healthz／readyz、无账号登录、JSON 解析失败、缺失凭据、未知登录方式、未支持的绑定、媒体类型、请求过大、缺失 access token、未知路径、错误方法和非规范路径，共 13 项均返回 HTTP 200 与对应 code，失败无 data、响应 no-store。日常库无邮箱账号，未创建验收账号；账号／设备／会话数量仍为 0。另以专用 PostgreSQL 执行 go test -count=1 -race ./...，全部通过，覆盖成功登录、设备替换、刷新并发与回滚；测试容器已清理，用户运行实例保持运行。

按用户要求重组 server 文档：README 保留模块索引、全局规则、本地开发和测试构建入口；认证、HTTP 接入与限流详情放入 server/docs/，模块索引提供链接。部署交付 TODO 同样移至 server/docs/deployment.md，不新增 deploy/README。限流文档明确已确认方案与尚未实现的通用额度／配置化边界。本次只修改文档，检查相对链接和 diff，不运行功能测试。


限流收尾已实现：业务请求先检查共享的通用 IP 额度，再检查接口专用额度；仅 GET /healthz 和 GET /readyz 豁免，未知路径与错误方法仍计数。四项限流均支持 YAML、同目录 .env 和进程环境变量，保留默认值并拒绝非正阈值或窗口。沿用内存计数，通用与认证计数器独立保存，避免专用键容量影响通用额度；超限统一 HTTP 200、code 10007 和向上取整的 Retry-After。配置模板和限流文档已同步。

本次验证通过配置与 HTTP 单测、隔离 PostgreSQL 上 go test -count=1 -race ./...、just check。实际 HTTP 验证环境变量阈值和窗口生效、专用拒绝仍消耗通用额度，以及耗尽后健康探针可用；既有登录、设备、刷新与数据库回归通过。临时 PostgreSQL 容器已停止并自动删除，未操作日常数据库或重启用户实例；变更未提交。


小切片 02B 完成：新增独立时间戳迁移，在 users 上添加默认 user／可选 admin 角色及持久的一次性 admin_bootstrap 记录，不改动已执行的迁移。启动时读取 XIAOWEI_BOOTSTRAP_ADMIN_EMAIL／PASSWORD，在开放 HTTP 前规范化邮箱、校验 6–32 个可打印 ASCII 字符密码并使用已有 Argon2id 哈希；事务锁保证并发启动只创建一次，邮箱冲突不升级旧账号，用户、身份或标记写入失败均回滚。重复初始化不更新账号或密码，移除环境变量后仍复用现有接口登录；当前只保存角色，不新增管理 API 或客户端角色字段。配置模板、服务端说明及后续工作已同步。

验证通过隔离 PostgreSQL 上 go test -count=1 -race ./...、just check 及 CGO_ENABLED=0 独立二进制构建。真实 HTTP 验证空用户库首次初始化、管理员正常登录／退出、重启后的会话和密码保留、改变或移除变量不新增管理员、无效配置和已占用邮箱在监听前失败且不留下部分账号；数据库测试验证并发唯一、最终写入失败回滚、初始化持久化与升级后旧用户仍为 user。测试日志未包含邮箱、初始密码或密码哈希；仅有既有 Select.tsx Biome 信息提示。临时 PostgreSQL 容器已清理，未改动日常数据库或重启用户实例，未提交。

用户重启后的本地现场验收通过：使用用户提供的测试管理员凭据请求 10001 端口，登录、查询当前用户和退出均返回 HTTP 200 与 code 0；退出后同一 access token 查询返回 UNAUTHENTICATED（10002）。使用独立随机设备 ID，验收会话已退出，未记录密码或 token，未重启服务。

切片 02A 已接入已确认的设置账号卡片、服务器选择与添加、邮箱密码浮层、UID 和退出。新增 Account Gateway 契约、TS main 账号 owner、共享 UUID 与独立登录态文件；未新增 package、crate、OAuth、注册或 WS 能力。

验证通过 just gen、just check、pnpm contracts:test、pnpm build:rust 和完整 pnpm --dir desktop test，覆盖 Gateway／HTTP／文件边界、错误密码、恢复、离线、合并刷新、撤销、迟到登录取消、跨域重定向拒绝与轮换后保存失败。真实本地 Go 联调使用独立临时账号存储和设备，验证错误密码 10100、成功登录、关闭后恢复、退出及旧 access 返回 10002；临时文件已删除，会话已撤销。

用户已启动 oracle 桌面实例，进程 cwd 与 renderer app-path 均属于当前工作区，启动日志正常；首次账号文件使用本地默认地址、有效 UUID 和 0600 权限。真实 Electron 窗口未开放 CDP，按用户现有控制偏好等待手动登录反馈后继续文件保存、重启恢复与退出验收；这些验收尚未通过，不据自动测试宣称切片完成。

用户随后明确不自动添加本地地址，已移除默认服务器参数，开发态与正式态首次列表均为空。当前未登录的本地配置已移除此前自动添加的地址，保留设备 UUID；账号五项测试、桌面类型检查和 diff 检查通过，并触发当前 oracle 实例重启。

用户确认存储调整：设备 ID、服务器列表与选择存入 Storage meta 的 account.config；设备 ID 不接入 Keychain。登录态独立保存至 $APP_DATA/xiaowei/auth.json，按用户要求直接使用普通 JSON，退出删除文件，不重复保存设备及地址列表。刷新提前量改为 5 分钟；账号选择框移除左侧标签，空列表文案改为“添加服务器”。本地旧 account.json 已一次性整理并删除，保留原 UUID，不加入运行时旧格式兼容。验证通过真实 Rust Storage／SQLite 的账号测试（包含到期前 5 分钟边界、恢复和退出）、23 项 main 测试、6 项相关 UI 测试及 just check；只有既有 Select.tsx 的信息提示。当前 oracle 实例已重启并正常加载，启动日志无本次存储错误；真实窗口登录验收仍待用户反馈。

用户明确要求移除本地加密：已删除加密适配、可用性检查、Base64 密文格式及相关测试夹具。auth.json 使用普通 JSON 保存服务器和生成契约的认证结果，登录不再依赖系统安全存储。真实 Gateway／HTTP／SQLite／文件测试确认 token 按原值保存、密码不持久化、公开快照无凭据，恢复、5 分钟刷新、取消、轮换保存失败及退出清理继续通过；23 项 main 测试、生成与 just check 均通过。当前本地无旧登录态文件，无需格式转换；已触发 oracle 实例重建并重启，真实窗口登录验收仍待反馈。

用户已确认真实桌面登录成功。登录 loading 至少 500 毫秒，期间卡片保持未登录，结束后与浮层同步切换；错误位于标题与服务器信息的原有空隙，卡片两种状态统一为 58px。回归测试复现并修复状态事件先于 loading 结束导致卡片提前切换，6 项相关 UI 测试、类型及 Biome 检查通过。经用户同意，在本地数据库事务中删除两组验收设备及其已撤销会话，关联 access token 通过外键级联删除；核对剩余 1 个真实设备、5 条会话及 5 条 access token，其中有效会话仍为 1 条，账号未修改。自动清理延期。

用户随后确认实施定时清理，保留期限从失效时刻计算。新增标准库 scheduler 模块和认证事务清理，启动执行一次、每 24 小时重试，单次超时 1 分钟，退出取消并等待任务后再关库；会话保留 6 个自然月，过期 access token 保留 7 天，设备保留。移除刷新接口提前删除过期 token 的逻辑。隔离 PostgreSQL 上全套 Go race、vet 和 CGO_ENABLED=0 构建通过，覆盖期限边界、UTC 月末计算、有效凭据保留、设备保留、刷新不提前删除、幂等清理及失败回滚；真实 HTTP 启动入口验证启动清理和清理失败仍可就绪且记录错误。定时模块测试覆盖失败重试、不重叠、超时、取消和退出等待。日常数据库未执行本次自动清理，现有运行服务需重启才加载；server 文档已同步，临时测试容器与二进制完成验证后清理。

客户端登录切片已收尾：当前 oracle 实例于 16:31:32 启动，auth.json 于 16:31:33 经恢复流程成功校验后写回。只读核对确认文件为普通 JSON、权限 0600，meta 设备 ID 和服务器选择与认证结果一致、meta 不保存 token；用文件中的现有凭据查询 `/api/auth/me` 返回 HTTP 200、code 0，用户、设备和会话均匹配。生产桌面日志包含此前登录和退出成功事件，实际数据库保留当前有效会话；未为验收退出用户当前登录。结合已有真实 Gateway／HTTP／Storage／文件测试，登录、保存、退出及重启恢复验收完成；最终 just check 通过，仅有既有 Select.tsx 信息提示，已删除客户端 Plan。统一 HTTP 日志按用户要求作为独立后续工作，不在本次补单接口日志。


独立 HTTP 日志切片完成：提取客户端 main/http/ 通用请求层，认证封装改名为 account/api.ts，保留认证请求编码、结果校验、错误消息和既有传输行为。服务端新增日志中间件，响应写出时标注 code，不缓存或解析响应体；保留业务事件及安全内部诊断，移除普通拒绝和限流的重复汇总。两层职责与敏感信息规则已同步至 main README 和 server/docs/http.md，不增加日志框架、协议字段或配置。

验证通过全部 40 项 main 测试、专用临时 PostgreSQL 上完整 go test -count=1 -race ./...、Go vet 和 just check，仅有既有 Select.tsx 的 Biome 信息提示。测试覆盖任意业务路径、单条汇总、各日志等级、真实 10 秒 HTTP 超时、认证错误映射、限流、panic 前后写出、写出失败和隐私哨兵；真实 HTTP 认证集成验证四个认证接口的成功 info、凭据拒绝和限流 warn、数据库故障 error，原有凭据泄漏断言继续通过。确认 oracle 的 Electron／nodemon 进程命令、cwd 与父子关系后使用 just rs，实际日志于 2026-10-07 17:11:46.279 记录启动恢复 GET /api/auth/me，debug、HTTP 200、code 0、耗时 94 ms，只有约定元信息；没有退出用户会话。临时数据库容器已停止并自动删除，日常数据库未写入验收账号；现有 Go 进程需重启才加载新日志实现。对应 Plan 已删除，变更未提交。


按用户补充要求，客户端和服务端均增加 HTTP request started，在实际网络请求／业务 handler 之前记录；服务端所有请求开始统一 info，成功结束统一 info，移除健康检查的日志等级例外，限流豁免不变。客户端开始与成功结束均为 debug，改为单行 key=val 文本；两端请求日志不再输出 outcome，内部错误分类只用于等级选择和业务封装。路由层提前提供安全路径供通用中间件记录，不增加路径脱敏特判。HTTP 文档和 main 模块说明已同步。

本次补充验证通过 22 项客户端 HTTP／账号测试、HTTP 接入 race 测试、专用 PostgreSQL 上完整 Go race 测试及 just check。断言开始日志先于网络／handler 执行，开始与结束各一次，路径一致，各失败路径等级保持，单行文本没有对象展开或 outcome，两条日志均未泄漏敏感哨兵。确认 oracle 活进程归属后执行 just rs，2026-10-07 17:23:26.526／17:23:26.537 的真实启动恢复 GET /api/auth/me 分别输出 debug 开始与结束，结束为 HTTP 200、code 0、耗时 11 ms。临时数据库容器已停止并自动删除，未退出当前用户或写入日常验收账号；Go 开发进程需重启生效，变更未提交。


客户端 HTTP 调用重组已由 [xwapi 事项](../archived/2026-10-07-xwapi-service.md)交付：原始服务器接口经 Gateway 对 TS／Rust 提供强类型调用，默认在本地检查 access 会话，仅登录、刷新及两个健康检查免除普通登录要求。xwapi 不管理会话，Account 产品登录、刷新、恢复、取消补偿及退出语义继续保留；当前边界及未来 WebSocket 方向见 [xwapi 长期文档](../../../docs/xwapi.md)，验收证据保留在归档 record。

切片 07 的本地实现已收敛：服务端新增 --check-config，复用配置加载校验并在数据库连接、迁移和 HTTP 启动前退出；错误仅指出文件／字段，不输出秘密。server-image workflow 仅手动触发、仅发布 linux/amd64，source_ref 解析为固定 SHA 后供测试和发布共用，部署包通过 release.txt 关联源码、run 和镜像 digest，不创建 server tag 或 GitHub Release。depoly-server 技能已同步实际输入及产物核对方式；workflow headSha 与应用源码 SHA 分开核对。

升级新增 backup.sh，保存数据库、完整配置及权限、Compose 和版本信息，以原子替换维护唯一 latest.tar；备份失败保留原副本并恢复旧服务，upgrade-pending 防止失败重试覆盖回滚点。恢复流程在需要数据库降级时重建目标数据库再导入，避免遗留失败迁移新增对象。部署文档已包含候选配置检查、备份／恢复命令及首次接入步骤。

本次验证通过专用临时 PostgreSQL 上的完整 go test -count=1 -race ./...、just check（含 Go vet）、actionlint、技能格式／链接和 git diff --check。linux/amd64 镜像已在本机 Docker 构建并运行完整隔离 Compose 验收：无依赖配置检查、错误配置保留旧服务、初始化／登录／刷新／退出、容器重建保留会话、数据库故障探针、单份备份及 0600 权限、备份失败恢复旧服务、pending 重试保护、完整配置目录及权限恢复、移除失败迁移新增表并恢复账号与会话。测试容器和临时数据已清理；仅有既有 Select.tsx 的 Biome 信息提示。当前密码登录版本交付能力的实施 Plan 已删除；完整邮箱版本仍依赖 03–06。
