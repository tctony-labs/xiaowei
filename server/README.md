# Go 服务端

独立 Go HTTP 服务，使用 PostgreSQL 持久化。目前提供运行配置、启动迁移、用户存储、邮箱密码登录、设备会话和健康检查；邮箱注册、找回密码与 WebSocket 尚未实现。Go 版本见 [go.mod](go.mod)，设计与验收结果见 [用户与登录 record](../.agent/records/active/2026-09-25-user-authentication.md)。

## 模块索引

| 目录 | 职责 |
| --- | --- |
| `cmd/xiaowei-server/` | 进程入口、模块装配与启动退出 |
| `internal/config/` | 配置读取与校验 |
| `internal/db/` | PostgreSQL 连接、迁移及用户、身份与会话存储 |
| `internal/auth/` | 密码校验、随机登录凭据与设备会话规则 |
| `internal/httpapi/` | HTTP 路由、认证接入、限流与健康检查 |
| `config/` | YAML、`.env` 及模板 |
| `deploy/` | Dockerfile 与 Compose 文件 |

## 文档

文档按配置准备、通用接入规则、业务功能、部署交付的顺序排列；通用规则在前，具体业务在后。

- [配置模板](config/server.example.yaml)
- [环境变量模板](config/.env.example)
- [HTTP 接口](docs/http.md)
- [限流设计](docs/rate-limiting.md)
- [认证与会话](docs/authentication.md)
- [部署交付](docs/deployment.md)

## 本地开发

安装 Node.js（版本要求见根目录 [package.json](../package.json)）、Go、just 和 Docker Compose。日常在 Docker 中运行 PostgreSQL，在本机运行 Go；以下命令在仓库根目录执行。

先准备配置与 Docker 依赖：

```sh
just prepare-server
```

配置缺失时，命令会输出需要执行的 `cp` 命令并停止，不自动创建或覆盖文件。两份模板使用本地开发密码 `password`，默认本地开发无需修改配置；调整密码时修改 `.env` 中的 `XIAOWEI_DATABASE_PASSWORD` 即可。准备命令只检查文件是否存在，配置内容由 Docker Compose 与 Go server 在启动时校验。复制后重新执行，命令会启动依赖并等待就绪；重复执行不会重启配置未变化的正常容器。

启动服务：

```sh
just server
```

`just server` 会先执行 `prepare-server`，然后启动 Go server。Go 默认监听 `127.0.0.1:10001`，连接 Docker 数据库的 `127.0.0.1:5432`。

运行终端支持直接按键，无需回车：

| 按键 | 行为 |
| --- | --- |
| `r` | 重新编译并重启 Go server，保留依赖容器 |
| `R` | 停止 Go server，重建依赖容器并等待就绪，再重新编译并启动 Go server；保留数据库数据卷 |
| `h` | 显示帮助 |
| `Ctrl+C` | 先退出 Go server，再停止 Docker 依赖，保留容器与数据卷；下次准备时重新启动 |

依赖清单位于 `deploy/compose.yaml`，不包含小微 server，后续新增依赖也放入这份清单。数据库用户名、库名与密码的初始化设置只作用于空数据卷，重建容器不会修改已有数据库中的账号。

## 配置与健康检查

主配置模板见 [server.example.yaml](config/server.example.yaml)，可选 env 覆盖见 [.env.example](config/.env.example)。优先级为默认值 < YAML < 同目录 `.env` < 外部进程 env。密码含 `$` 或 `#` 时用单引号包裹。真实配置不提交到 Git。

`just server` 默认读取 `server/config/server.yaml` 及同目录的 `.env`。其他 YAML 路径可在 `server/` 中指定，程序同样读取它旁边的可选 `.env`：

```sh
go run ./cmd/xiaowei-server --config /path/to/server.yaml
```

服务完成数据库连接与迁移后才监听 HTTP，失败则退出。迁移使用 UTC 时间戳版本；其他分支已执行的迁移会保留并提示，不阻止启动。迁移约定见 [用户与登录 record](../.agent/records/active/2026-09-25-user-authentication.md#启动迁移与健康检查)。另开终端检查：

```sh
curl -f http://127.0.0.1:10001/healthz
curl -f http://127.0.0.1:10001/readyz
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
node --test scripts/dev/server.test.mjs
```
