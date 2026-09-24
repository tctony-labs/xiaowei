# 引入统一 Storage 模块

## Why

目前剪贴板由 `xiaowei-clipboard` 自行维护 SQLite。随着跨业务查询和 setting 持久化需求增加，需要统一数据库所有权及访问机制，避免各业务重复持有连接。

多个 `.node` 即使依赖同一个 Rust crate，也不会共享其中的全局变量或数据库实例。Storage 必须是独立运行实例，通过已完成的 [Gateway](2026-09-18-implement-gateway.md) 提供服务。

## What

本轮顺序为 DB → meta KV（保存 setting 数据）→ 剪贴板接管统一 DB。模块为 `xiaowei-storage`，Rust 入口位于 `crates/xiaowei-storage/`，npm 入口位于 `napi/`。

已确定：

- 整个应用使用一个 SQLite 数据库，DB 和 meta KV 共库，由 Storage 统一持有连接。
- 数据库迁移沿用旧版 `xiaowei-next` 的 `migration_v2` 机制，不沿用旧迁移条目。
- 清除当前剪贴板 v1→v2→v3 的升级历史，直接建立重构后的基线。
- 用户授权直接移动当前机器的数据库，按需调整结构和内容；不开发历史数据自动导入或兼容流程。
- Config 暂缓，不作为本轮前置条件。不在本轮搬入 Settings 页面或全部旧版 setting 业务。

DB、meta KV、剪贴板接管和桌面接线已实现；当前机器数据库已完成离线切换，最终桌面运行验收待完成。

## How

### 数据库实例与布局

沿用旧版 SQLx，由 Storage native 实例创建唯一的应用连接池；不额外创建旧版 SeaORM 连接池。统一所有权不等于只允许一条物理连接。

main 的 `paths.ts` 生成并传入路径，布局为：

```text
userData/xiaowei/
├── storage.sqlite
└── clipboard/    # 业务附件由剪贴板管理
```

统一库包含 `meta`、`clipboard_items`、`clipboard_categories`，以后按业务增加表。通用的 `items`／`categories` 改为业务前缀，索引与外键同步调整。

连接创建时统一配置 foreign_keys、busy timeout 和同步策略，数据库启用 WAL。启动顺序为 Storage 初始化／迁移完成 → 业务 endpoint 接入 → 采集和页面可用；退出先停止业务生产者和等待中的调用，再关闭 Storage。

### Storage 内部数据库

SQLite 查询、事务和 migration_v2 仅由 Storage 内部使用，对外不发布通用 Database service。剪贴板经有类型的 `ClipboardDao` Gateway endpoint 请求存储操作。

内部查询提供参数化执行与完整原子事务，值显式区分 NULL、int64、double、text 和 blob。renderer、main 和其他 Rust 业务不提交 SQL，也不管理连接或迁移。

用户已确认：查询重复项、条件合并及删除必须在 Storage 内的一次原子事务中执行完毕，不暴露跨 RPC 长期持有的 begin／commit 句柄。优先用参数化 SQL 与条件语句表达事务；前一步结果引用、断言及返回结果的具体协议，必须用剪贴板 edit_text 的重复项合并场景验证后确定，不预先扩展成通用脚本语言。

剪贴板表结构、SQL 和记录操作由 Storage 维护；剪贴板模块仍负责采集、附件生命周期和页面行为。跨模块请求不得在主线程同步等待，也不能在 main 等待剪贴板线程退出时让该线程等待 main 转发数据库请求。

### migration_v2

已完整核对旧版 `crates/xw-core/src/db/migration_v2/mod.rs`，并查看普通建表及包含文件清理的迁移实例。实际行为是：

- 文件名为 `m{YYYYMMDDHHmmss}_{description}.rs`，迁移名称不含开头的 m。
- 显式注册 up／down，按注册列表顺序执行 up，不按文件名自动扫描或排序。
- 完成后写入 `meta` 的 `migration_v2.<name>`，JSON 值为执行时间（Unix 秒）；已有标记则跳过。
- 提供 status、回滚目标解析及单条 down。指定名称可以回滚任意已登记条目，并非自动逆序回滚整个后缀。
- 旧实现把 up 与标记写入分成两个步骤，没有框架级原子事务、checksum 或完整依赖校验；down 也不保证恢复已删除的文件或数据。

本轮沿用时间戳命名、显式注册、up／down、meta 完成标记及 status。只注册新的基线和以后真实新增的迁移，不复制旧版 foo、聊天等历史条目，不继承剪贴板 `user_version=3`。

本轮补强：纯数据库迁移使用同一连接的事务，up 与写入完成标记一起提交，down 与删除标记一起提交。失败停止启动，不发布未完成初始化的业务服务。回滚默认只允许最后一个已执行条目，避免跳过后继依赖；回滚为显式维护动作，不在启动失败时自动删除已有数据。这些是相对旧机制的明确调整，不描述成旧版原有保证。

meta 表需先以最小固定结构建立，解决“迁移依赖 meta 记录，而 meta 自己还不存在”的启动问题。随后由 Storage 执行内部注册的剪贴板基线迁移。原有名称、schema 和完成标记保持不变；本次移动代码与调用边界不需要旧数据库数据迁移。

文件系统操作不与 SQLite 事务原子提交。本次本机文件移动作为离线一次性操作处理，不塞入常规运行时迁移。以后若有涉及文件的真实迁移，再为该迁移明确恢复策略。

### meta KV 与 setting

沿用旧版 `xw-core/src/db/meta.rs` 的基本模型：

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
```

value 保存有效 JSON 文本，key 使用完整字符串。setting 使用 `setting.` 前缀；迁移状态使用 `migration_v2.` 前缀，共享 meta 表。公开 `KeyValue` 拒绝内部 `setting.*` 和 `migration_v2.*` key；Storage 内部仍按原 key 访问。

提供精确读取、写入、删除及按字面前缀查询；区分 key 不存在和 JSON null，非法 JSON 拒绝写入，前缀中的 `%`／`_` 不作为 SQL 通配符。对外契约为 `KeyValue`；`meta` 是 Rust 内部的 SQLite 表与存储实现。

`xiaowei-storage/src/settings` 负责设置默认值、类型校验、逐项持久化和提交后通知。通用 `KeyValue` 只提供公开 key 的原始 JSON KV，不提供设置语义，也不另建 KV 引擎。其他模块通过 `Settings` 更新设置。

### 本机接管与历史清理

已只读核对 `~/Library/Application Support/com.tctony.xiaowei/xiaowei/clipboard/history.sqlite`，当前 schema 为 3，业务表是 items 和 categories，图片位于 clipboard/images。

接管新代码时确认所有使用者已关闭，处理 WAL、关闭连接，再移动数据库并调整表名、外键及新基线状态。调整后的库必须与全新创建的基线一致；不能在旧代码仍会打开旧路径时提前移动，避免它重建空库。

删除旧剪贴板逐版本升级分支、旧图片 BLOB 导出逻辑及仅服务于历史兼容的测试／说明。保留仍有效的业务行为测试。Git 历史无需改写；清理的是当前运行时代码和文档中已失效的兼容负担。

## Alternatives considered

- 仅共享 Rust crate、各 `.node` 自行建库：不能统一实例和所有权，不采用。
- 多业务数据库由 Storage 分别管理：用户已选择单一应用数据库，不采用。
- 把旧剪贴板各版本升级搬进新系统：用户明确要求清除历史，不采用。
- DB、meta、Config 各建一个原生包：不采用；当前一个 Storage 模块，Config 后续再讨论。
- 直接复制 migration_v2 并宣称迁移全程原子：旧实现不具备该保证，需明确上述补强。

## Current work

Gateway 前置条件已完成，用户已确认进入实施阶段。计划依次执行：

1. 00：DB 核心、事务与 migration_v2 已完成，结果见 Outcome。
2. 01：meta KV 与原生 Gateway 接入已完成，结果见 Outcome。
3. 02：剪贴板存储接管已完成，结果见 Outcome。
4. [03：桌面装配、本机切换与验收](../../plans/2026-09-18-implement-storage/03-desktop-cutover.md)。

临时提醒：本次顺便调整长文本文件存储，细节与数据清理授权见 Plan 02／03；实现完成后删除本提醒，不写入本 record 的长期 How 或 Outcome。

Plan 00–02 已完成并提交。Plan 03 的 lazy clients、启动失败清理测试和桌面打包已完成，本机切换和真实 Electron 接口验证已完成，产品交互人工验收待反馈。此前交付时公开 Database endpoint；后续边界调整已收拢为 Storage 内部 SQL 和有类型的 ClipboardDao endpoint。每个切片完成即回填结果并删除对应 Plan；本机数据库调整仅在最后切换阶段执行，不与前期开发混在一起。

FTS／tokenizer 从 DB 与 meta 基础中拆为独立的 [Storage FTS5 全文检索能力](2026-09-24-fts5-search.md)，具体注册、依赖来源和验证在该事项维护。Config 保持暂缓。

验收包括：新库完整初始化、已有迁移跳过、失败时 SQL 与标记共同回滚、显式 down、参数与 BLOB／int64 往返、事务隔离和业务条件合并、meta 前缀／JSON null／跨重启持久化、跨模块及可信 renderer 访问、剪贴板业务行为回归。本机接管后核对完整性、外键和附件引用。不要求实现任意历史版本升级。


### DB 实施细节

SQLx 固定 0.8.6。初次实施时的工具链 Rust 1.92 不满足 SQLx 0.9 正式版的 Rust 1.94 要求，SQLx 0.8 的 libsqlite3-sys 0.30 又与旧 rusqlite 0.37 冲突，因此剪贴板在接管前临时使用 rusqlite 0.32.1，共享 libsqlite3-sys 0.30.1；接管后删除 rusqlite，不引入 SQLx alpha 或私有 patch。develop 后续已将工具链固定为 Rust 1.98.1，本轮 rebase 保留 SQLx 0.8.6，不顺带升级数据库依赖。

Storage 内部提供 Query／Execute／Transaction 和 ApplyMigrations／MigrationStatus／Rollback。事务用 BEGIN IMMEDIATE 持有写锁，参数可引用前序结果的 step／row／column，expected_rows 断言失败回滚整个事务；列按索引返回并保留重名。单 SQL 64 KiB、128 参数，事务最多 64 步，完整结果最多 10000 行／4 MiB。SQL 类型和执行方法仅在 Storage 内部可见，外部通过 typed KV／Settings／DAO 调用，不开放 SQL 或迁移入口。移除旧 SQL Gateway 设计遗留的 authorizer；prepare 只保留单语句、参数数量、Query 只读检查及结果列信息读取，属于内部调用约定，不作为操作授权边界。取消查询通过 progress handler 中断执行，事务 Drop 回滚，连接归池前清理 progress handler。

migration_v2 接收完整有序的声明列表（名称、up SQL、down SQL）；当前已执行状态必须是该列表的前缀，未知或顺序不一致的记录拒绝执行。每条迁移及其 meta 标记在同一事务中提交；meta 表先自举，回滚只允许最后一条已执行迁移。


## Outcome

### Plan 00：DB 核心与 migration_v2

已实现 SQLx DB 核心、typed Database 契约与 Rust Gateway handlers、受限 SQL 验证、可引用前序结果的原子事务以及 migration_v2。完成标记与 SQL 同事务；长查询取消通过 SQLite progress handler 释放执行和连接。

`cargo test -p xiaowei-storage --locked` 的 5 项测试通过，覆盖 SQLite 值类型、SQL 管理语句拒绝、结果大小、条件合并、失败回滚、并发事务、长查询取消和迁移 up/down。`just check`、`just test` 通过，搜索和剪贴板正式 native 包已重建，现有剪贴板回归通过。未操作本机数据库；当前运行的桌面属于 prometheus 工作区，未重启它，也未冷启动当前工作区。此阶段只需自动验证，无产品人工验收，Plan 00 已删除。


### Plan 01：meta KV 与原生 Gateway

以下为当时的交付记录；后续设置模块接入时，公开的 `Meta` 服务更名为 `KeyValue`，底层表和数据未迁移。

Meta.Get／Set／Delete／List 与 Database 共用同一 SQLx pool。key 为 1–1024 字节（前缀可为空），JSON 上限 1 MiB；列表返回完整 key，按 binary 排序，字面匹配前缀，超过 DB 返回预算时报错。缺失 key 用 optional json 缺失表达，已存 JSON null 返回文本 "null"；无独立缓存或 Config 逻辑。

Storage.open(path) 完成 SQLite 初始化，createGatewayEndpoint 生成十条正式 typed route；endpoint.close 先关闭 Gateway，再关闭连接池。新增包纳入两个 workspace、正常原生构建及集成脚本；桌面生产接线尚未切换。

`just check`、`just test` 和 `pnpm gateway:test-native` 通过。新增 Rust meta 测试、Node 原生生命周期测试和真实跨 addon Storage 测试验证初始化失败、幂等关闭、持久化、字面前缀及 TS／另一 Rust addon 共用数据。原 14 项 native 传输／流测试和 2 项生产业务测试通过，搜索／剪贴板／Storage 正式 native 产物已构建。此阶段无需产品人工验收，Plan 01 已删除。


### Plan 02：剪贴板接管共享数据库

剪贴板已移除 rusqlite、自有 Connection 和旧 user_version 升级链，使用生成的 Database typed client；业务维护最终 clipboard_items／clipboard_categories 基线，通过 migration_v2 初始化。Service 的数据库调用和监控停止改为异步，后台 client 使用 native endpoint 激活后取得的宿主身份，业务嵌套调用通过 task-local 保留请求的权限上下文。查询、条件合并、删除及最终读取在一个事务中完成。

为保持切片可构建，已同步桌面的最小 Storage 依赖与初始化接线；Storage 先打开、剪贴板初始化后启动监控，Storage 最后关闭。当前机器数据库尚未切换，没有重启其他工作区实例。

Rust 业务回归、原生历史／编辑测试、桌面资源适配测试、真实 Gateway native 联调及 `just check`／`just test` 通过；包含跨原生数据库访问及受限调用不能提升数据库权限的回归。三个原生包已重建为正式产物。Plan 02 已删除，产品人工验收与本机调整统一在 Plan 03 执行。

### Plan 03：本机切换与接口验证已完成

已增加 renderer 的 lazy Database／Meta clients，以及桌面启动失败和反向关闭的故障注入测试。`just check`、`just test`、完整 Gateway native 测试、桌面构建和未签名打包通过；三个打包原生模块均通过解包后的 JS 加载器验证，Storage endpoint 可打开和关闭临时数据库。真实 renderer 验收脚本已在当前工作区 Electron 中执行通过。

本机数据库已在所有使用者关闭后完成备份、离线移动和结构调整。统一 storage.sqlite 保留原库 174 条记录和分类，以及新库新增的 5 条记录，共 179 条；基线结构、完整性、外键及图片引用核对通过，旧 history.sqlite 路径已不存在。备份保存在 `~/.xiaowei/backups/storage-cutover-20260921-114307/`。产品交互人工验收尚待明确反馈，保留 Plan 03；用户已要求提交当前成果并合入 develop。

当前工作区运行实例的 Electron 实测已通过：renderer 调用 Database／Meta、临时 Storage 关闭重开持久化以及事件／流生命周期验证均成功。正式数据库完整性与外键正常，测试数据及隔离窗口已清理。产品人工验收仍待完成。用户确认切换后曾启动其他工作区的旧代码，导致旧路径重新创建；其中唯一文本已在统一库中，确认无使用者后已将旧库归档到上述备份目录，保留其原始元数据。

### 后续边界调整（2026-09-23）

数据库查询、事务、meta、剪贴板基线迁移及记录 SQL 收拢至 `xiaowei-storage`。对外删除通用 Database 契约，保留公开 `KeyValue`，增加剪贴板内部的 `ClipboardDao` 有类型 endpoint；设置实现成为 Storage 内部模块。剪贴板仍维护采集和附件生命周期，但不提交 SQL。原 `storage.sqlite`、表结构、`migration_v2.20260920000000_clipboard_baseline` 标记与记录数据直接沿用，本次不执行旧库数据迁移。以上调整替代前述各 Plan 交付时的跨模块 SQL／Database endpoint 设计；历史验收记录保留当时事实。
