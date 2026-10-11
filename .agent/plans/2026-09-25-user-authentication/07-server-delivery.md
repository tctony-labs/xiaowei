# 07 服务端构建发布与线上部署

## 范围与验收

用户要求优先处理切片 07，跑通线上流程。本次先交付当前邮箱密码登录版本的镜像发布、HTTPS 部署、初始化、升级、备份恢复与回滚流程。SMTP／邀请注册、找回密码和 WebSocket 尚未实现，原切片 07 的完整邮箱版本验收继续保留，不能以本次部署验收替代。

用户明确发起部署后，Agent 通过仓库级 depoly-server skill 手动触发 workflow_dispatch，再执行后续上线流程。push、PR 和版本 tag 不触发 server 镜像构建发布，不创建 server tag。使用公开仓库对应的 GHCR 镜像，仅构建、验收和发布 linux/amd64，不需要 arm64。默认使用远端 develop 的最新已提交版本，也可由用户指定分支或 commit。CI 在发布前执行专用 PostgreSQL 上的 Go race／vet 和真实容器验收；镜像使用完整 Git SHA 标签，生产配置固定 digest，不使用 latest。部署包通过本次 run 的 workflow artifact 交付，不依赖 GitHub Release。

线上目标已确定：上海 tctony.com，业务域名 xiaowei.tctony.com，服务根目录 /data/xiaowei/，首个管理员邮箱 tony@tctony.com。初始密码由 Agent 随机生成并保存在本机权限为 0600 的私有文件中，不写入对话、日志或版本库。

用户已授权开始实现。配置检查入口、仅 workflow_dispatch／amd64 的镜像流程、发布元信息与单份备份入口已落地并通过本地验收；不提交、不触发远端构建，也不改动线上服务。实际 CI 发布、上海部署与公网验收需用户明确发起部署后继续，本 Plan 因仍有这些验收保留。

## 配置升级决定

新增 `--check-config` 模式，复用实际配置加载和校验，检查文件、字段、类型、必填项及相互约束；通过时退出码为 0，失败时以非零退出码指出文件或字段，不输出秘密。该模式在数据库连接、迁移和 HTTP 启动之前退出。

升级先复制现有配置为候选副本，按版本说明补齐新增文件和必填项、处理改名与删除，保留用户值。使用新镜像及对应候选 Compose／挂载／环境变量运行临时检查容器，旧服务保持运行。检查通过后停止旧应用写入，备份数据库和当前镜像／配置／Compose，再切换；检查失败不停止旧服务。采用单实例原地升级，允许短暂停机。新增文件必须同步纳入加载、检查和部署挂载。每次部署记录源码 SHA、run ID、镜像 digest 和配置快照的对应关系。

升级前仅保留最近一份配套回滚备份；新备份成功并校验后才替换上一份。备份失败阻止升级，保留原备份并恢复旧服务。升级成功后保留该备份，直到下一次有效备份替换；失败重试不能用失败或部分迁移的状态覆盖原回滚点。不增加定时备份或历史备份保留。

配置检查只覆盖已实现的静态校验，数据库及外部服务连通性由后续验收覆盖。回滚镜像与配置不自动回滚数据库迁移。

## 文件与职责

| 文件 | 类型 | 具体改动 |
| --- | --- | --- |
| `.agent/skills/depoly-server/SKILL.md` | 新增 | 用户发起部署后，手动触发构建、关联本次产物、检查配置并执行部署与验收 |
| `AGENTS.md` | 修改 | 注册 depoly-server skill 的触发条件 |
| `.github/workflows/server-image.yml` | 新增 | 仅 workflow_dispatch 触发服务端专用测试、amd64 原生容器验收和 GHCR 发布；上传本次无源码部署包，移除自动触发、arm64 和 tag Release 草案 |
| `server/cmd/xiaowei-server/main.go`、`main_test.go` | 修改 | 增加独立 `--check-config`，复用配置校验并在数据库／HTTP 启动之前退出；装配可信代理来源处理 |
| `server/deploy/Dockerfile` | 修改 | 构建 linux/amd64 应用和静态 readiness 探针，保留 nonroot 和受限构建上下文 |
| `server/cmd/xiaowei-healthcheck/main.go` | 新增 | 读取本容器 readiness 的 HTTP 状态和业务 code，数据库不可用时返回非零；不启动服务或读取凭据 |
| `server/cmd/xiaowei-healthcheck/main_test.go` | 新增 | HTTP 200 但 code 非零、缺少 code、错误响应和网络失败的探针验收 |
| `server/deploy/compose.xiaowei.yaml` | 修改 | 独立生产 Compose：镜像引用、私有数据库、持久数据、只读配置、服务 readiness、日志轮转与退出等待；无需源码或开发 Compose |
| `server/deploy/server.example.yaml` | 新增 | 容器专用 YAML，明确同机容器数据库地址和固定服务监听 |
| `server/deploy/.env.example` | 新增 | 生产镜像 digest、数据库凭据及一次性管理员初始化模板，无默认生产密码 |
| `server/deploy/backup.sh` | 新增 | 停止旧服务、保存数据库和配套文件、原子替换最近一份备份；失败恢复旧服务，pending 标记防止失败重试覆盖回滚点 |
| `server/deploy/verify.mjs` | 新增 | 隔离真实生产 Compose 的配置预检查、登录／刷新／退出、重建保留会话、数据库故障 readiness、备份恢复验收；备份失败／重试保护及重建数据库恢复验收；失败清理隔离资源 |
| `server/deploy/nginx.example.conf`、`nginx.logrotate` | 新增 | 上海 HTTPS 反代、覆盖来源头和独立日志轮转 |
| `server/internal/config/config.go`、`config_test.go` | 修改 | 显式可信代理 CIDR 的 YAML／env 配置及校验；复用配置检查路径 |
| `server/internal/httpapi/proxy.go`、`proxy_test.go` | 新增 | 仅对可信 TCP 来源接受单个有效 X-Real-IP，验证代理后的额度隔离和直接请求伪造拒绝 |
| `server/internal/httpapi/limiter.go` | 修改 | 优先使用经可信代理校验的来源 IP，默认继续使用 TCP 来源 |
| `server/config/server.example.yaml`、`.env.example` | 修改 | 增加可信代理配置示例，默认不信任代理头 |
| `server/docs/rate-limiting.md` | 修改 | 说明反向代理来源边界与配置入口 |
| `server/docs/deployment.md` | 修改 | 无源码部署、发布触发、HTTPS 反代、初始化、日志、升级、备份恢复、回滚命令与缺失能力 |
| `server/README.md` | 修改 | 同步生产交付入口、健康检查与专用部署验收命令 |
| `.agent/records/active/2026-09-25-user-authentication.md` | 修改 | 更新 07 当前范围、实际交付结果、验收证据与完整邮箱版本未满足的前置条件 |

不新增 npm package、Rust crate、服务端依赖或 MCP。不修改根 docs/。沿用已有账号与迁移逻辑。

## 实施顺序

1. 镜像发布：按手动触发方案收敛 workflow；先完成镜像所需的配置检查入口、readiness 探针及隔离容器验收。验证 linux/amd64、真实 PostgreSQL race、完整源码 SHA 和本次部署包／digest 关联。实际触发需要用户发起部署，所需源码提交和推送另遵守授权规则。
2. 生产部署：收敛独立 Compose、配置模板与候选配置检查，按 depoly-server skill 部署到上海；检查数据库端口、回环监听、持久数据和实际 readiness。
3. HTTPS 接入：首次部署复用上海 Nginx 和现有证书，接入 xiaowei.tctony.com；常规升级仅验证现有公网 TLS、代理来源和 HTTP 业务 code，只有接入配置变化时才调整并重载 Nginx。
4. 初始化与登录：使用已确定的邮箱初始化管理员，通过 HTTPS 验证正误密码、当前用户、刷新、退出及重启恢复，移除一次性初始化变量。
5. 运维流程：核对日志、升级前检查、备份恢复与回滚步骤；破坏性恢复演练使用隔离数据库。回填文档、record 和实际验收证据。

## 完成与保留项

本次上线流程须具备真实手动触发 CI 发布和 HTTPS 访问证据，不能仅凭本地镜像构建宣布完成。管理员密码不在文档、日志或发布包中保存。数据库迁移的回滚以兼容性评估或备份恢复为准，不承诺任意镜像降级都安全。

原 07 的邀请开户、真实 SMTP 和 WSS 验收依赖 03–06，继续留在 record。全部本次工作完成后将持久决定与验证证据回填 record，并删除此 Plan。

## 当前进展与剩余验收

本地实现和验收已完成：完整 Go race（专用 PostgreSQL）、just check、actionlint、amd64 镜像构建与实际 Compose 验收通过。容器验收覆盖配置检查失败不停止旧服务、单份备份／失败恢复／重试保护，以及完整配置权限和数据库恢复；隔离测试资源已清理，结果已回填 record。

剩余工作为用户授权的源码提交／推送，以及用户明确发起部署后的真实手动 CI 发布、GHCR 产物核对、上海首次部署、首次公网接入、初始化和线上登录验收。尚未执行这些操作，不以本地通过代替线上完成；原切片 07 的 SMTP／邀请与 WSS 前置能力仍未完成。
