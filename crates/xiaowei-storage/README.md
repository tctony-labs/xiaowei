# xiaowei-storage

应用共享存储核心及其 napi 入口。统一持有 SQLx SQLite 连接池，管理迁移、meta KV、设置持久化与业务 DAO；`napi/` 是桌面消费的 npm 入口。其他业务通过 typed Gateway endpoint 访问，不提交 SQL 或自行管理本库连接。

## 文档

- [共享存储接入](../../docs/storage.md)：跨包所有权、路径、桌面装配与生命周期。
- [数据库实现](docs/database.md)：包内连接、事务、migration_v2、meta、Settings 与 FTS5 注册。
- [xw-tokenizer](../xw-tokenizer/README.md)：分词与 SQLite 注册约定。
- [Rust 原生模块开发](../README.md)：模块边界、构建与平台接入约定。

## 验证

在仓库根目录运行 `cargo test -p xiaowei-storage -p xw-tokenizer --locked` 验证数据库与分词能力；原生包构建入口为 `pnpm --filter xiaowei-storage build:debug`，绑定测试入口为 `pnpm --filter xiaowei-storage test`，后者需有当前代码的原生产物。

[src/tests/](src/tests/) 覆盖事务、迁移、meta、设置及 FTS5，[napi/test/](napi/test/) 覆盖原生生命周期。真实跨 addon 调用与桌面故障清理由 [桌面测试](../../desktop/tests/README.md) 承载，不与同一 addon 的构建并行运行。
