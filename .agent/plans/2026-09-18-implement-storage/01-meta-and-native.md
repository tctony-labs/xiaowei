# 01：meta KV 与原生 Gateway 接入

关联 [Storage 事项](../../records/active/2026-09-18-implement-storage.md)。前置：00 的数据库与迁移执行器通过验证。

## 范围与文件

- 新增 `contracts/proto/xiaowei/meta.proto`：Meta 的读取、写入、删除和前缀查询。
- 新增 `crates/xiaowei-storage/src/meta.rs`、`src/gateway.rs`、生成绑定：DB 与 meta 共享同一服务实例及连接池。
- 新增 `crates/xiaowei-storage/napi/` 的 Cargo.toml、package.json、build.rs、src/lib.rs、src/gateway.rs：endpoint 创建、传输、关闭；按既有两个包的结构构建，不暴露平行的业务 napi API。
- 更新根 `Cargo.toml`、pnpm workspace 配置（如匹配模式需要）、锁文件、契约入口和生成绑定检查。
- 新增 `crates/xiaowei-storage/tests/meta.rs`、`napi/test/`；扩充 `gateway/ts/test/native/`、`gateway/tests/native.mjs` 与 production 检查以覆盖第三个正式原生包。

## 实施顺序

1. Meta 使用完整 key 和有效 JSON 文本，区分缺失与 JSON null；返回具名 deleted 等结果。前缀按字面且大小写精确匹配，稳定排序，并明确返回完整 key。限制 key／value／返回批量大小，超限显式报错，不能静默漏 setting。
2. 使用同一 SQLx pool 实现读取、upsert、删除、前缀查询。保留 `setting.` 与 `migration_v2.` 的前缀约定，不增加另一份缓存、Config 默认值或变更事件机制。
3. 注册 typed Database／Meta handlers；初始化错误不发布可用 endpoint，close 停止接受新调用并释放连接。业务迁移通过 00 确定的初始化入口运行。
4. 接入正式 napi endpoint，复用现有传输机制；若需要提取 Gateway 的重复适配代码，仅处理本次接入确实需要的部分，不扩大核心重构。
5. 增加 native 集成测试：TS 和另一 Rust endpoint 经 Gateway 访问同一数据库，确认不存在每个 `.node` 各建实例的问题。所有测试使用临时目录。
6. 生成并构建最新 native 包，更新脚本中“恰好两个包”等既有假设；此阶段不修改桌面生产启动，不创建正式 storage.sqlite。

## 验证与完成条件

- JSON 标量／对象／数组／null、Unicode key、空值、非法 JSON、缺失删除、字面 `%`／`_` 前缀、跨重启持久化。
- 并发写入与读取、事务结果、endpoint 关闭和初始化失败的资源释放；无测试 fixture 混入正式入口。
- `pnpm --filter xiaowei-storage build:debug`、`pnpm gateway:test-native`、`just check`、`just test` 通过。联调脚本结束恢复受影响模块的正式 native 产物。
- 无产品 UI 人工验收；最终 renderer 直接访问在 03 验证。回填结果并删除本 Plan。
