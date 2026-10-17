# 合并为两个 native addon

## 范围与布局

- 新增 `crates/xiaowei-rust/README.md`：桌面常规 Rust 能力的接入与边界。
- 新增 `crates/xiaowei-rust/napi/{Cargo.toml,package.json,build.rs,src/,test/}`：Cargo 包 `xiaowei-rust-napi`，npm 包和 binaryName 为 `xiaowei-rust`；该目录直接依赖四个 `xw-*` 核心，根目录不建空转发 crate。
- 移动四个原 napi 的手写绑定到 `src/{search,clipboard,storage,platform}/`；保留业务公开方法、实例所有权和关闭顺序。
- 新增共用 `src/gateway.rs`：只导出一个 GatewayEndpoint，集中协议方法；显式区分 Storage／Clipboard 资源所有权和清理。
- 新增共用 `src/logging.rs`：常规 addon 只初始化一次 sink，保留 log target、等级和原始源码位置；Agent addon 的 sink 保持独立。
- 删除旧四个 napi 包与只做 re-export 的 `xiaowei-platform` 核心；保留 Agent 两个 crate。

## 配套修改

- 修改 Agent napi：提供独立输出的 gateway-fixtures 测试构建，与常规 addon 一起覆盖跨两个动态库的调用；生产输出不暴露 fixture。
- 修改桌面 imports、依赖、startup mock，Vite 外部包白名单和 builder 输入清单，运行时只保留 xiaowei-rust／xiaowei-agent。
- 修改 Gateway／desktop／native 绑定测试、fixture 构建及 production 检查，合并为 rust／agent 两组；fixture 与 production 输出继续隔离，release CI 哈希检查覆盖两份生产二进制。
- 修改 release 内容校验、架构／原生加载校验、发布回归与 CI 测试入口；验证新常规 addon 仍导出 SparkleUpdater。
- 通过 pnpm 同步 npm 依赖锁文件，通过 Cargo 同步 Rust 锁文件，不升级第三方版本。
- 更新 `crates/README.md`、原生包／核心包文档、`desktop/src/main/README.md`、`desktop/docs/macos-release.md`、`desktop/tests/README.md`、根 docs 架构／日志／Gateway／存储说明及受影响开发 skill 的当前路径。归档 record 保留原有历史内容，根 README 不改。

## 验收与提交

1. 新 addon 原生编译成功且导出无重名，正常包只生成两个 `.node`；Cargo workspace 18 个包。
2. native／Rust 核心测试及 Gateway 两 addon 的 unary、stream、event、权限、取消、关闭和 fixture 隔离回归通过；按契约维护流程运行 desktop 完整测试。
3. release 构建两份二进制，实际 ad-hoc 目录包通过内容、签名、元数据、架构和原生加载校验；隔离解包验证实际业务调用与 LLM worker。
4. 对照合并前 app 292,015,646 bytes，记录两份 native 和整包真实体积；Agent 与常规包之间仍存在的共享实现不视为已消除。
5. 恢复工作区 debug 产物；更新 record Outcome，删除 Plan 并单独提交。Agent 不冷启动 Electron；用户启动后的 GUI 验收保持待办。
