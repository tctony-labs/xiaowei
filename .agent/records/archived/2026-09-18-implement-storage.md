# 引入统一 Storage 模块

## Why

目前剪贴板由 `xiaowei-clipboard` 自行维护 SQLite。随着跨业务查询和 setting 持久化需求增加，需要统一数据库所有权及访问机制，避免各业务重复持有连接。

多个 `.node` 即使依赖同一个 Rust crate，也不会共享其中的全局变量或数据库实例。Storage 必须是独立运行实例，通过已完成的 [Gateway](../active/2026-09-18-implement-gateway.md) 提供服务。

## What

本轮顺序为 DB → meta KV（保存 setting 数据）→ 剪贴板接管统一 DB。模块为 `xiaowei-storage`，Rust 入口位于 `crates/xiaowei-storage/`，npm 入口位于 `napi/`。

已确定：

- 整个应用使用一个 SQLite 数据库，DB 和 meta KV 共库，由 Storage 统一持有连接。
- 数据库迁移沿用旧版 `xiaowei-next` 的 `migration_v2` 机制，不沿用旧迁移条目。
- 清除当前剪贴板 v1→v2→v3 的升级历史，直接建立重构后的基线。
- 用户授权直接移动当前机器的数据库，按需调整结构和内容；不开发历史数据自动导入或兼容流程。
- Config 暂缓，不作为本轮前置条件。不在本轮搬入 Settings 页面或全部旧版 setting 业务。

DB、meta KV、剪贴板接管、桌面接线及本机离线切换已交付，本轮按用户确认结项。

## How

当前跨包所有权、桌面路径、服务装配与生命周期维护在 [共享存储接入](../../../docs/storage.md)；连接、事务、migration_v2、meta KV、Settings 和 FTS5 注册维护在 [Storage 数据库实现](../../../crates/xiaowei-storage/docs/database.md)。

选择由一个 Storage native 实例统一持有共享业务数据库；多个 `.node` 依赖同一 crate 不会共享内存实例，因此通过 Gateway 访问同一实例。统一数据库所有权不限制物理连接数量。后续边界收敛为 typed KV、Settings 和 ClipboardDao，SQL、事务和迁移留在 Storage 内，不开放任意 SQL 或跨 RPC 事务句柄。

沿用旧版 SQLx、时间戳迁移名称和 meta 完成标记，重新建立业务基线，不复制旧迁移历史。旧版 up 与状态写入缺少统一事务，因此补强为同一连接原子提交；显式回滚限制为最后一条当前已执行迁移，避免跳过依赖。未知迁移标记保留并忽略，实际 SQL 失败仍阻止初始化，不自动撤销既有数据。

本机数据库接管采用关闭所有使用者后的离线备份、移动和结构调整，不增加常规运行时的旧库导入或兼容分支。文件操作与 SQLite 事务不具备共同原子性，历史切换结果保留在 Outcome。

## Alternatives considered

- 仅共享 Rust crate、各 `.node` 自行建库：不能统一实例和所有权，不采用。
- 多业务数据库由 Storage 分别管理：用户已选择单一应用数据库，不采用。
- 把旧剪贴板各版本升级搬进新系统：用户明确要求清除历史，不采用。
- DB、meta、Config 各建一个原生包：不采用；当前一个 Storage 模块，Config 后续再讨论。
- 直接复制 migration_v2 并宣称迁移全程原子：旧实现不具备该保证，需明确上述补强。

初次实施选择 SQLx 0.8.6，是当时 Rust 工具链要求及 SQLite 绑定版本冲突下的取舍；剪贴板接管前临时调整 rusqlite 版本，接管后删除该依赖，没有引入 SQLx alpha 或私有 patch。后续工具链升级未顺带改变本轮数据库方案。

## Outcome

2026-10-07 用户确认剪贴板真实桌面验收已完成，并同意将 Search 与 Storage 按本轮范围结项归档。DB、meta、剪贴板接管、桌面接线和本机切换的自动化及真实接口证据保留如下；原待人工反馈的结项状态已回填，已删除完成的 Plan 03 和临时长文本提醒。

共享存储的当前说明已分别沉淀至根目录与包内文档。Config、剪贴板旧版行为差异及旧项目数据导入不纳入本次结项；后续独立工作不再以本 record 承载。

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

### 初始化迁移范围调整（2026-09-24）

初始化忽略当前注册列表之外的迁移标记，只执行当前列表中的待执行迁移；不再根据未知标记拒绝启动。桌面失败清理仅注销已成功注册的图标协议，避免遮蔽原始初始化错误。15 项 Storage Rust 测试通过，覆盖额外迁移的保留、当前待执行迁移的执行及实际 SQL 初始化错误；Storage napi 包已重建，桌面 TypeScript 检查通过。用户启动后已确认初始化通过；后续当前 oracle 实例重建并重启验证，实际数据库写入缺少 tokenizer 的错误发生在后台保存阶段，按剪贴板错误处理记录。
