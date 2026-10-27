# 配置、存储与迁移

Go 服务端使用 PostgreSQL 保存用户、邮箱身份、设备和会话。配置由 [internal/config](../internal/config/config.go) 加载，连接、迁移和存储事务由 [internal/db](../internal/db/db.go) 管理，与桌面端的 Rust Storage／SQLite 无依赖。开发入口见 [服务端 README](../README.md#本地开发)，生产目录、备份和回滚见 [部署交付](deployment.md)。

## 配置加载

默认读取当前工作目录下的 `config/server.yaml`；`just server` 在 `server/` 中运行。`--config` 可以指定其他 YAML 路径，其同目录的 `.env` 随之切换，不另从 cwd 查找。

优先级为 **内置默认值 < YAML < YAML 同目录的可选 .env < 外部进程 env**。只允许代码明确登记的环境变量覆盖，不自动开放所有字段。显式空 env 同样覆盖低优先级值，并按字段规则校验，不因其为空回退。`.env` 由 godotenv 读取，不修改进程环境；缺失文件允许继续，不可读或解析失败则报错，不回显秘密。

YAML 必须存在且只能包含一个 document；未知字段、重复键和错误类型均拒绝启动。配置仅在启动时读取，不做变量插值或热更新。数据库密码原样保留；与 Compose 共用的密码含 `$` 或 `#` 时使用单引号，保证两种读取方式按字面量处理。

| YAML 字段 | env 覆盖 | 默认值／要求 |
| --- | --- | --- |
| `server.listen_addr` | `XIAOWEI_LISTEN_ADDR` | `127.0.0.1:10001`；有效 host:port，端口 1–65535 |
| `database.host` | `XIAOWEI_DATABASE_HOST` | 必填 |
| `database.port` | `XIAOWEI_DATABASE_PORT` | 5432；端口 1–65535 |
| `database.name` | `XIAOWEI_DATABASE_NAME` | 必填 |
| `database.user` | `XIAOWEI_DATABASE_USER` | 必填 |
| `database.password` | `XIAOWEI_DATABASE_PASSWORD` | 必填，不裁剪空白 |
| `database.ssl_mode` | `XIAOWEI_DATABASE_SSL_MODE` | `verify-full`；只支持 `verify-full`／`disable` |

认证有效期见 [会话与轮换](authentication.md#会话与轮换)，限流字段见 [限流配置](rate-limiting.md#配置)，可信代理见 [可信反向代理](deployment.md#可信反向代理)。初始化凭据只接受环境变量，不属于 YAML schema，具体规则见 [首次管理员初始化](authentication.md#首次管理员初始化)。完整示例维护在 [YAML 模板](../config/server.example.yaml) 和 [环境变量模板](../config/.env.example)。

服务端入口清除相关 libpq `PG*` 环境变量，数据库连接使用上述统一配置，不从环境中的其他数据库账号、passfile 或 TLS 参数补充配置。`verify-full` 使用系统信任根、校验服务器名，最低 TLS 1.2；本地开发和同机私有 Compose 网络的模板显式使用 `disable`。

`--check-config` 复用配置加载及静态校验，通过时退出 0，不连接数据库、不迁移、不初始化账号或监听 HTTP。它不能证明数据库可达；管理员变量目前只检查是否成对，邮箱和密码格式仍由实际首次初始化检查。新增配置文件必须同时接入加载、校验和部署挂载，不能仅添加模板。

## 启动与退出

```mermaid
flowchart LR
    Config[加载并校验配置] --> DB[连接 PostgreSQL]
    DB --> Migration[事务执行迁移]
    Migration --> Admin[按需首次初始化管理员]
    Admin --> HTTP[监听 HTTP]
    HTTP --> Cleanup[后台认证记录清理]
```

数据库连接建立超时 5 秒，连接及迁移共用 30 秒启动期限，连接池最多 10 个连接。初始化管理员使用独立的 30 秒期限。上述步骤失败时不开放 HTTP；后台认证记录清理失败则记录错误，不阻止 HTTP 服务启动。

`POST /api/Health/Check` 检查进程能响应，`POST /api/Health/Ready` 在 2 秒期限内探测数据库；业务 code 才表示是否就绪，HTTP 200 本身不代表成功。数据库中断时进程保持运行，数据库恢复后 readiness 可恢复。完整响应约定见 [健康检查](http.md#健康检查)。

SIGINT／SIGTERM 触发 HTTP 优雅退出，最多等待 5 秒；随后取消并等待后台任务结束，再关闭数据库池。日志写入标准错误，保留操作名称、迁移版本和安全诊断，不输出密码、完整 DSN、原始 YAML 值或底层数据库错误中的敏感细节。

## 数据库迁移

[migrate.go](../internal/db/migrate.go) 通过 `go:embed` 打包 SQL，并登记 UTC `YYYYMMDDHHMMSS` 时间戳版本。Go 使用 int64，`schema_migrations` 保存 bigint 版本、SQL 的 SHA-256 和应用时间。

启动时在单个数据库事务内获取 advisory lock，核对当前代码已知迁移的校验和，将尚未执行的迁移按时间戳排序应用并登记，最后整体提交。重复时间戳、无效日期或已知迁移的校验和变化均拒绝执行；失败回滚本次事务，不清库、不自动降级。

数据库中存在当前构建不认识的迁移时，仅记录提示并保留其结构与历史。已执行较晚迁移不阻止补执行合并后出现的较早迁移；补执行 SQL 必须兼容数据库当前结构。允许未知版本不等于保证旧代码兼容新结构，实际不兼容会在业务 SQL 调用时失败，回滚仍须评估结构兼容性。

新增迁移应：

1. 在 `internal/db/migrations/` 使用有效 UTC 时间戳命名，例如 `20261003143000_add_email.sql`。
2. 在 migrate.go 中嵌入并登记同一版本，不能修改已经应用的迁移。
3. 为兼容已有代码，新增字段允许为空或提供合适默认值，业务查询显式列出字段。
4. 使用隔离 PostgreSQL 验证首次执行、重复启动、失败回滚、并发迁移及必要的旧结构升级，不能只验证 SQL 可以解析。

当前基线分别创建用户、邮箱身份与设备会话、管理员角色与一次性初始化记录。运行代码没有开发期旧序号版本或 integer 历史字段的特殊兼容分支。

## 用户标识与持久数据

各服务器独立管理账号；客户端以服务器地址和公开 `user_id` 区分身份，不跨服务器自动合并同邮箱账号。

`users` 同时保存内部 bigint identity 主键 `id`、公开 `user_id`、创建时间和角色。公开 ID 使用 128 位密码学安全随机值，编码为 `u_` 加 22 位无填充 Base64URL，数据库精确区分大小写并保证唯一，碰撞时重新生成，最多尝试三次。它不是自增 ID 的编码或哈希。

内部关联使用 `id`／`user_pk`，对外消息只使用公开标识；内部 User.ID 不参与 JSON 序列化。随机 ID 不能替代认证或数据归属检查。角色默认 `user`，另有 `admin`；保存角色不代表已经实现管理 API 权限体系。

用户、登录身份和设备会话分表保存；基础用户可以没有邮箱身份，存储层创建用户不等于产品注册。认证表关系与事务语义见 [认证存储与事务](authentication.md#存储与事务)。数据库迁移结构以 SQL 和当前代码为准，后续注册、密码重置和微信身份仍待实现。
