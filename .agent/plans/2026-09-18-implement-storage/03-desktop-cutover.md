# 03：桌面装配、本机切换与验收

关联 [Storage 事项](../../records/active/2026-09-18-implement-storage.md)。前置：00–02 通过临时库及 native 集成测试。

## 范围与文件

- `desktop/src/main/{paths,gateway,clipboard,index}.ts`：统一 storage.sqlite 路径，Storage → 业务基线 → 剪贴板监控的启动顺序和反向关闭。
- `desktop/src/renderer/src/services.ts`：沿用 lazy getter，为 Database／Meta 提供 typed client，不新增 facade。
- `desktop/package.json`、`desktop/electron.vite.config.ts`、`desktop/scripts/build-main.mjs` 与实际打包配置：第三个 native 包的构建、外置及 ASAR unpack。
- `desktop/scripts/gateway-acceptance/` 与相关 tests：真实 renderer 直接访问、新 endpoint 生命周期；只用临时测试数据库和隔离 host，不写用户 setting 作为测试。
- `docs/{workspace,rust-napi}.md`、业务 proto README、Gateway README、Storage／剪贴板 active records：同步真实路径、包数量和已消除的偏差。

## 实施顺序

1. main 创建唯一 Storage endpoint，提交业务声明的迁移并等待成功后接入剪贴板；任何步骤失败按逆序回收，Storage 最后关闭。不得保留备用独立剪贴板 DB。
2. 更新 lazy clients、构建和打包，检查 fixture 脚本、加载器和声明不会遗漏第三个包。用临时目录完成桌面接线测试和未签名打包验证。
3. 完成所有受影响 napi 包构建。盘点运行进程及 SQLite 使用者，按绝对路径／cwd／父子关系确认归属；不得停止其他工作区实例。若有无法安全关闭的使用者，报告具体阻塞，不在线移动 WAL 数据库。
4. 在无使用者时执行一次性本机调整：核对源库与目标是否存在；若目标已有数据则先比较，不覆盖。对源库 checkpoint 并关闭连接，移动为 storage.sqlite；同一数据库事务内删除全部旧 largeText 记录、重命名业务表／索引、调整外键并建立 meta 及基线状态。删除范围包括旧收藏的 largeText，其他内容不因本次清理而删除。重置不再使用的旧 user_version。不保留运行时迁移入口。
5. 只在核对实际结构与全新基线一致后写入完成标记，检查 integrity_check、foreign_key_check、记录计数与图片引用；large_text 目录供新数据使用，不导出旧长文本。一次性脚本如用于执行，执行完删除，不作为长期兼容代码提交。
6. 核实数据库可用后按运行实例规则重新加载：只有确认当前工作区存在运行实例才可 just rs；无实例由用户冷启动。禁止由 Agent 运行 just start／Electron 冒烟启动入口。
7. 验收后删除 Storage record 中关于长文本顺带调整的临时提醒；该调整不写入 Storage record 的长期 How／Outcome，相关当前行为仅维护在剪贴板说明中。随后更新 Storage Outcome；删除本 Plan 及空目录，Storage record 留在 active。仅用户明确要求时提交。

## 自动验证

- `just check`、`just test`、`pnpm gateway:test-native`；桌面 build 与未签名 package，确认正常包内三份 native 模块均可加载。
- 故障注入验证 Storage 初始化失败、业务基线失败、monitor 启动失败后的清理；重复启动和正常退出不泄漏连接，不重建旧 history.sqlite。
- 现有 Electron 条件允许时验证 typed renderer Database／Meta 调用、事件和关闭；无实例则明确留待用户启动，不能把单测当作真实 Electron 验收。

## 人工验收

- 搜索与剪贴板正常；普通文本、图片、分类、收藏和备注保留，旧长文本已删除。
- 新复制长文本可预览、复制全文、编辑、外部打开；长短互转、合并及删除后附件行为正确。
- 重启后 setting 的 meta 测试数据（由测试隔离管理）和新剪贴板内容持久化；数据库统一，旧路径不再创建文件。
- 不要求 Settings 新页面、Config、FTS、其他平台或签名发布；这些不属于本轮完成条件。
