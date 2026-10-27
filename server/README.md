# Go 服务端

独立 Go HTTP 服务，使用 PostgreSQL 持久化。目前提供运行配置、启动迁移、用户存储、邮箱密码登录、首次管理员初始化、设备会话、健康检查和认证 WebSocket；邮箱注册与找回密码尚未实现。Go 版本见 [go.mod](go.mod)，当前实现见下列模块文档，未完成范围由 [server-development](../.agent/records/active/2026-10-11-server-development.md) 跟进；历史取舍与验收见 [用户与登录归档](../.agent/records/archived/2026-09-25-user-authentication.md)。

## 模块索引

| 目录 | 职责 |
| --- | --- |
| `cmd/xiaowei-server/` | 进程入口、模块装配与启动退出 |
| `cmd/xiaowei-healthcheck/` | 容器内 readiness 探针，检查 HTTP 状态与业务 code |
| `internal/config/` | 配置读取与校验 |
| `internal/db/` | PostgreSQL 连接、迁移及用户、身份与会话存储 |
| `internal/auth/` | 密码校验、随机登录凭据与设备会话规则 |
| `internal/httpapi/` | 共享 API 注册、HTTP／认证 WS 接入、限流与健康检查 |
| `internal/httpapi/ws/` | WebSocket 接口协议、请求执行、服务端通知及响应流 |
| `internal/scheduler/` | 后台定时任务、执行超时与退出取消 |
| `config/` | YAML、`.env` 及模板 |
| `deploy/` | Dockerfile、独立生产 Compose、部署模板与隔离容器验收 |

## 文档

文档按配置准备、通用接入规则、业务功能、部署交付的顺序排列；通用规则在前，具体业务在后。

- [配置模板](config/server.example.yaml)
- [环境变量模板](config/.env.example)
- [配置、存储与迁移](docs/persistence.md)
- [HTTP 接口](docs/http.md)
- [限流设计](docs/rate-limiting.md)
- [WebSocket 接入](docs/websocket.md)
- [认证与会话](docs/authentication.md)
- [部署交付](docs/deployment.md)

生产使用 CI 发布的 GHCR 镜像和部署包，不需要服务器持有源码。生产 Compose 与本地开发依赖清单独立；发布、HTTPS、初始化、升级与备份恢复步骤统一维护在部署文档。

## 本地开发

安装 Node.js（版本要求见根目录 [package.json](../package.json)）、Go、just 和 Docker Compose。日常在 Docker 中运行 PostgreSQL，在本机运行 Go；以下命令在仓库根目录执行。

共享 PostgreSQL 通过独立入口管理：

```sh
just db start
just db stop
just db restart
just db status
```

`start` 创建或启动数据库并等待就绪；`stop` 停止数据库，保留容器与数据卷；`restart` 先停止再启动；`status` 只查询容器状态、健康状态和端口。停止或重启会影响所有工作区的数据库连接。

本地配置文件的准备统一放在 `scripts/dev/server-config.mjs`。`just server` 在 `.env` 或 `server.yaml` 缺失时，分别从同目录的 `.env.example`／`server.example.yaml` 自动复制并继续启动；已有文件不覆盖。`just db start`／`restart` 只准备共享 `.env`，不要求应用的 `server.yaml` 存在。`.env` 同时包含数据库和其他服务端设置，配置准备逻辑不属于 PostgreSQL 生命周期脚本。

两份模板使用本地开发密码 `password`，默认本地开发无需修改配置；调整密码时修改 `.env` 中的 `XIAOWEI_DATABASE_PASSWORD` 即可。配置内容由 Docker Compose 与 Go server 在启动时校验。重复启动数据库不会重启配置未变化的正常容器。

需要首个登录账号时，在 `.env` 中设置管理员初始化邮箱和密码；具体规则见 [首次管理员初始化](docs/authentication.md#首次管理员初始化)。

启动服务：

```sh
just server
```

`just server` 依次检查配置、检查 HTTP 端口并处理接管确认、确保共享 PostgreSQL 就绪，最后启动 Go server；端口接管回答 `no` 时不会操作数据库。Go 默认监听 `127.0.0.1:10001`，连接 Docker 数据库的 `127.0.0.1:5432`。

首次启动时，开发脚本 `scripts/dev/server.mjs` 在运行 Go 前检查配置中的监听地址能否绑定；配置优先级为默认值 < YAML < `.env` < 外部进程环境变量。地址被占用时调用本机 `lsof`／`ps` 报告监听地址、PID、父进程和 cwd，并在终端询问是否终止已展示的监听进程：输入 `yes`／`y` 后发送 SIGTERM，确认端口释放后继续本次启动；输入 `no`、直接回车或结束输入则退出。确认后会重新核对进程身份；信息不足、终止失败或端口五秒内未释放时停止，不自动强杀。非交互终端不终止占用者。接管只终止监听进程，保留对方控制脚本及 Docker 依赖。`r` 不执行预检；预检释放端口后仍可能发生竞争，最终以 Go 的实际监听结果为准。

运行终端支持直接按键，无需回车：

| 按键 | 行为 |
| --- | --- |
| `r` | 重新编译并重启 Go server，保留依赖容器 |
| `h` | 显示帮助 |
| `Ctrl+C` | 退出当前 Go server 与控制脚本，保留共享 PostgreSQL 运行 |

依赖清单位于 `deploy/compose.yaml`，不包含小微 server，后续新增依赖也放入这份清单。数据库用户名、库名与密码的初始化设置只作用于空数据卷，重建容器不会修改已有数据库中的账号。

各工作区使用固定的 Compose 项目名 `xiaowei-dev`，共用数据库容器与数据卷；重复启动会确保同一容器运行，不会为每个工作区新建数据库。Go 的重启和退出不操作共享数据库；需要停止或重启时使用 `just db stop`／`just db restart`。

## 配置与健康检查

主配置模板见 [server.example.yaml](config/server.example.yaml)，可选 env 覆盖见 [.env.example](config/.env.example)。优先级为默认值 < YAML < 同目录 `.env` < 外部进程 env。密码含 `$` 或 `#` 时用单引号包裹。真实配置不提交到 Git。

`just server` 默认读取 `server/config/server.yaml` 及同目录的 `.env`。其他 YAML 路径可在 `server/` 中指定，程序同样读取它旁边的可选 `.env`：

```sh
go run ./cmd/xiaowei-server --config /path/to/server.yaml
```

仅检查配置、不连接数据库或启动 HTTP：

```sh
go run ./cmd/xiaowei-server --config /path/to/server.yaml --check-config
```

检查复用正常启动的配置加载与静态校验，成功退出 0，失败返回非零且不输出配置秘密；数据库连通性和迁移仍由启动验收覆盖。

服务完成数据库连接、迁移及按需管理员初始化后才监听 HTTP，失败则退出。迁移使用 UTC 时间戳版本；其他分支已执行的迁移会保留并提示，不阻止启动。迁移约定见 [数据库迁移](docs/persistence.md#数据库迁移)。另开终端检查：

```sh
curl -f -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:10001/api/Health/Check
curl -f -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:10001/api/Health/Ready
```

检查响应中的 `code = 0`，不能仅凭 HTTP 200 或 curl 退出状态判断就绪。语义见 [HTTP 接口](docs/http.md#健康检查)。

## 测试与构建

测试与实现并排放置。

在 `server/` 中执行：

```sh
go test ./...
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -o bin/xiaowei-server ./cmd/xiaowei-server
```

数据库和认证集成测试需设置 `XIAOWEI_TEST_DATABASE_URL`，使用具有建库权限的专用测试连接。测试只操作自身创建的隔离数据库；认证测试通过真实 TCP HTTP 验证登录、刷新、退出及服务重启。未设置该变量时明确跳过，不能视为完整存储或认证验收。

开发启动脚本的测试在仓库根目录执行：

```sh
node --test scripts/dev/server.test.mjs scripts/dev/pgsql.test.mjs
```

生产容器验收在仓库根目录执行，仅使用自己创建的隔离 Compose 项目和临时数据目录：

```sh
docker build --platform linux/amd64 --file server/deploy/Dockerfile --tag xiaowei-server:delivery-test .
XIAOWEI_DEPLOY_TEST_IMAGE=xiaowei-server:delivery-test node server/deploy/verify.mjs
```

它验证无数据库配置预检查、检查失败保留旧服务、管理员初始化、真实认证 HTTP、重建保留会话、数据库故障 readiness、单份备份、备份失败恢复旧服务、重试保护和数据库恢复。服务端发布仅面向 linux/amd64：手动触发 CI，执行该验收和真实 PostgreSQL race 测试，通过后发布 GHCR 镜像。实际发布与线上验收需由用户发起部署，具体步骤见部署文档。
