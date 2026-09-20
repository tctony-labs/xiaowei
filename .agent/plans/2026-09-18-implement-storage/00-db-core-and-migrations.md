# 00：DB 核心、事务与 migration_v2

关联 [Storage 事项](../../records/active/2026-09-18-implement-storage.md)。前置：Gateway 已完成。本切片只使用临时数据库，不接管产品数据库。

## 范围与文件

- 新增 `contracts/proto/xiaowei/database.proto`：Database 服务、SQL 值、列与行、执行结果、原子事务及迁移描述；先读取业务 proto README。
- 新增 `crates/xiaowei-storage/Cargo.toml`、`src/lib.rs`、`src/db.rs`、`src/migration.rs`：SQLx 连接池、参数化 SQL、事务执行器、migration_v2；默认 crate 不依赖 napi。
- 新增 `crates/xiaowei-storage/tests/db.rs`、`tests/migration.rs`：真实 SQLite 行为测试。
- 更新 `contracts/{rust/src/lib.rs,ts/src/index.ts}`、生成产物、`gateway/rust/examples/generate_business.rs` 与 `gateway/rust/tests/business_binding.rs`：增加 Storage 绑定及漂移检查，沿用现有生成流程。
- 按需更新 Cargo 依赖与锁文件。暂不接入 Config、FTS、UI 或当前机器数据。

## 实施顺序

1. 核对 SQLx 与当前 rusqlite 的 libsqlite3-sys 版本能否共存，固定兼容依赖；不通过偷偷升级业务依赖绕过 links 冲突。先完成最小编译验证。
2. 先用剪贴板 edit_text 的完整 SQL 流程确定事务消息：同一连接执行查询、条件更新、删除及结果查询；业务负责 SQL，Storage 只执行通用步骤。优先采用 SQL 条件表达，只有实际用例需要时增加前序结果参数引用和行数断言，不做通用脚本引擎。
3. 定义 Query／Execute／Transaction 等契约的结果、NULL、int64、BLOB、参数绑定和限制。查询只接受只读语句；普通执行不得通过 BEGIN／COMMIT／ATTACH 或连接级 PRAGMA 绕开事务和统一连接管理。明确空结果、重复列名、非法参数、结果超限和错误映射。
4. 建立连接池，逐连接设置 foreign_keys、busy timeout、synchronous，启用 WAL。写事务在读取用于决策的数据前获得写锁，避免并发写入破坏条件合并；单次事务全部成功才返回。SQL 执行在 Gateway 取消／超时后仍须释放事务，不能留下占用连接的未提交状态。
5. meta 固定表自举后运行 migration_v2：时间戳名称、显式注册顺序、up/down SQL、完成时间标记、status。纯 SQL 与标记同事务，重复执行跳过，失败停止初始化；显式 down 仅允许最后一个已执行条目，不自动回滚历史数据。
6. 迁移定义用可传递的声明（名称及 up/down SQL），不跨 `.node` 传 Rust 闭包。业务在自身模块维护定义，宿主在启动装配时提交到 Storage 的初始化迁移入口；迁移完成前不开启对应业务。定义重复名称／顺序错误的拒绝规则，不引入旧机制没有要求的 checksum 系统。
7. 提供临时数据库的完整基线与重复项合并用例，证明协议能支持 Plan 02；同步契约说明与主 record。

## 验证与完成条件

- SQL 参数与 NULL／int64 边界／浮点／Unicode／空 BLOB／二进制往返；非法 SQL、参数不匹配、结果限额均有明确错误。
- 写后查询、前序依赖、重复项合并、事务中途失败全部回滚；并发合并／插入不产生丢失更新或部分删除。验证超时／取消后的连接可继续使用。
- 新库初始化、二次启动跳过、迁移中断重试、SQL 和 meta 标记一起回滚；down 的状态与数据一致，拒绝跳过后继迁移。
- `cargo test -p xiaowei-storage --locked`、绑定生成一致性、`just check`、相关契约测试通过。
- 无需产品人工验收；不得触碰本机数据库。完成后回填事务协议和迁移装配约定，删除本 Plan。
