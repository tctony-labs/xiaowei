# xiaowei-search

全局搜索核心及其 napi 入口。Rust 核心组织应用、系统设置、书签、命令与计算器候选，提供模糊匹配、拼音、高亮和最近使用加权；不依赖 Electron，不使用 SQLite／FTS5。`napi/` 是桌面消费的 npm 入口，宿主执行动作与窗口交互由桌面负责。

## 文档

- [搜索实现](../../docs/search.md)：Launcher、跨包调用链、数据源协作、执行边界与图标资源。
- [搜索引擎](docs/search-engine.md)：包内查询、评分、高亮及结果组织。
- [Rust 原生模块开发](../README.md)：模块边界、构建与平台接入约定。

## 验证

在仓库根目录运行 `cargo test -p xiaowei-search --locked` 验证核心；原生包构建入口为 `pnpm --filter xiaowei-search build:debug`，绑定测试入口为 `pnpm --filter xiaowei-search test`，后者需有当前代码的原生产物。

[tests/search.rs](tests/search.rs) 与源码单元测试覆盖来源和算法，[napi/test/](napi/test/) 覆盖绑定、预热与日志；真实跨 addon 业务联调由 [桌面测试](../../desktop/tests/README.md) 承载。不要将原生测试与同一 addon 的构建并行运行。
