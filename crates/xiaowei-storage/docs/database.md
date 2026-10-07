# Storage 数据库实现

本文描述 `xiaowei-storage` 内部数据库、持久化和全文检索基础。跨包所有权、桌面路径与服务生命周期见 [共享存储接入](../../../docs/storage.md)，构建与验证入口见 [模块 README](../README.md)。

## 连接与初始化

[Database::open](../src/db.rs) 接收数据库路径，创建父目录并通过 SQLx 打开 SQLite pool。连接统一开启外键、WAL、Full 同步和 5 秒 busy timeout，池上限为五条连接；统一实例不意味着只允许一条物理连接。

每条新连接在 `after_connect` 中注册 tokenizer 并设置 SQLite 长度、参数数量限制。连接就绪后先创建最小 `meta` 表，再执行 [内部迁移注册列表](../src/clipboard_migrations.rs)。注册或迁移失败会返回初始化错误，不发布未完成初始化的服务。

## SQL 与原子事务

[sql.rs](../src/sql.rs) 和 [db.rs](../src/db.rs) 提供包内 Query、Execute、Transaction。SQL 类型与执行入口不对外发布；业务通过 typed DAO 访问，不开放任意 SQL 执行服务。

参数显式区分 NULL、int64、double、text、blob，浮点数必须有限。事务通过 `BEGIN IMMEDIATE` 持有写锁，执行全部步骤后统一提交；参数可引用前序步骤的 row／column，`expected_rows` 不满足时整个事务回滚。外部不存在跨请求持有的事务句柄。

[validation.rs](../src/validation.rs) 检查单语句、参数数量与 Query 只读约定，并读取结果列信息。它是可信内部 SQL 的调用约定，不是对外 SQL 授权边界；不保留旧通用 SQL Gateway 的 authorizer 或 PRAGMA 白名单。

当前执行预算：

| 项目 | 上限 |
| --- | --- |
| 单条 SQL | 64 KiB |
| SQL 参数 | 128 个 |
| 单次事务 | 1–64 步 |
| 完整结果 | 10000 行、4 MiB；事务多步共用预算 |

结果列按索引保存，允许重名。查询取消通过 SQLite progress handler 中断；事务丢弃时回滚，连接归池前清除 progress handler，避免取消状态影响后续调用。

## migration_v2

[migration.rs](../src/migration.rs) 消费显式有序的声明列表，名称为 `YYYYMMDDHHmmss_description`，每条都提供非空 up／down SQL。名称必须唯一；不自动扫描文件，也不按时间戳重新排序。

完成状态保存为 meta 的 `migration_v2.<name>`，JSON 值为执行时的 Unix 秒数。初始化只检查当前注册列表：已有条目跳过，未执行条目按列表顺序执行；当前列表中的已执行项必须构成连续前缀。其他版本写入的未知迁移标记保留且忽略，不据此拒绝启动。

每条 up 与完成标记写入在同一 SQLite 事务中提交。失败停止本次初始化，已提交的前序迁移不自动撤销。内部 status 与显式 rollback 使用同一状态模型；down 与标记删除也在同一事务中，只允许回滚当前列表中最后一条已执行迁移。

meta 先以固定结构自举，解决迁移状态表自身尚不存在的问题。没有 checksum、自动后缀回滚或文件系统原子性保证；涉及文件的迁移需单独设计恢复策略。旧项目数据导入属于离线维护工作，不与常规 schema 升级混用。

## meta KV

[meta.rs](../src/meta.rs) 在同一连接池中使用以下结构：

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
```

value 是有效 JSON 文本，key 使用完整字符串。读取区分不存在与 JSON null：不存在返回缺失的 optional json，JSON null 返回文本 `null`。key 为 1–1024 UTF-8 字节且不含 NUL；List 允许空前缀，JSON 上限为 1 MiB。

List 按字面前缀匹配，`%`、`_` 不作 SQL 通配符；结果按 key 的 binary 顺序排列，仍受数据库总结果预算约束。KV 没有独立内存缓存。

[gateway.rs](../src/gateway.rs) 将内部 meta 包装成公开 `KeyValue`。Get／Set／Delete 拒绝保留的 `setting.*` 与 `migration_v2.*` key，List 过滤这些条目；内部设置和迁移仍按原 key 访问。

## Settings 与业务 DAO

[settings/](../src/settings/) 负责默认值、类型校验、逐项保存和变更通知，使用 `setting.` 前缀。更新串行执行：先应用宿主动作，再写入对应 meta key，成功后通知；宿主动作或持久化失败时尝试恢复原宿主状态，失败与恢复失败均向调用方返回。通用 KeyValue 不提供这些设置语义。

[ClipboardDao](../src/clipboard_dao.rs) 在 Storage 内维护业务表与 SQL，包含分页、筛选、去重合并和检索。正文编辑涉及目标查询、条件合并、来源删除和最终结果读取时，在一次原子事务中完成。具体剪贴板规则由 [剪贴板事项](../../../.agent/records/active/2026-09-17-migrate-local-clipboard.md)维护，本篇不重复定义其业务索引和附件行为。

[usage.rs](../src/usage.rs) 计算数据库本体和 `-wal`、`-shm` 普通文件的实际大小，缺失文件按零计，不跟随符号链接，不计目录；通过 typed 存储占用接口提供给宿主。

## FTS5 与分词器注册

Storage 依赖 [xw-tokenizer](../../xw-tokenizer/README.md)。`after_connect` 先持有 SQLite 原始连接的独占锁，再调用 `unsafe register(db)`；返回非 SQLITE_OK 时使连接初始化失败。每条池连接以及数据库重开后的新连接都重新注册，不使用进程级自动扩展，迁移在注册成功后执行。

分词器名称为 `xiaowei`，支持 `std` 和 `char` 模式。中文标准模式建索引用 Jieba `cut_for_search`，查询用 `cut`；重叠展开子词标记为同一 FTS 位置，索引与 snippet 辅助分词顺序一致。具体词集、字节偏移及 C 桥接约定由 tokenizer 文档维护。

底层能力可供业务建 FTS5 表，执行 INSERT、MATCH 和 snippet，不依赖剪贴板 schema 或 nucleo。索引字段、同步触发器、历史回填、候选上限及排序由对应业务 DAO 决定；没有通用索引管理协议。

连接注册和重开验证见 [数据库测试](../src/tests/db.rs)，分词行为见 tokenizer 自身测试，剪贴板索引验证见 [clipboard_search.rs](../src/tests/clipboard_search.rs)。引入能力的取舍与历史验证见 [FTS5 record](../../../.agent/records/archived/2026-09-24-fts5-search.md)。
