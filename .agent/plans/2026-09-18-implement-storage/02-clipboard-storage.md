# 02：剪贴板共享 DB 与长文本文件存储

关联 [Storage 事项](../../records/active/2026-09-18-implement-storage.md)。前置：00／01 已完成。先以临时 DB 和 fake clipboard 验证，产品切换由 03 完成。

## 范围与文件

- `crates/xiaowei-clipboard/src/store.rs`：删除自有 Connection 和旧版本升级，改用 typed Database client；保留业务 SQL／映射和校验。
- 新增 `crates/xiaowei-clipboard/src/migrations/`：最终 clipboard_items／clipboard_categories 基线及 down 定义，由业务导出并经宿主装配提交 Storage。
- `src/{service,gateway,types,lib}.rs`、`napi/src/{lib,gateway}.rs`：注入 Gateway client、异步生命周期和长文本持久文件；必要时独立 `src/files.rs` 处理附件，不引入通用文件服务。
- `tests/{history,gateway}.rs`、`napi/test/history.test.cjs`、`gateway/ts/test/native/business.test.ts`：业务及跨 native 回归。
- `desktop/src/main/clipboard-files.ts`、`desktop/scripts/clipboard-files.test.mjs`：外部查看长文本使用持久文件；图片与普通文本行为保留。
- 按需更新 clipboard.proto 的内部资源获取消息与生成产物，renderer 契约不暴露附件路径；同步 Cargo／锁文件。

## 实施顺序

1. 完整核对旧版 clipboard 的 types、storage、hash 及外部查看行为，沿用已确认阈值／摘要长度／路径；不重新设计 UI。
2. 定义最终业务基线，清除 user_version 升级分支、图片 BLOB 导出以及只服务于旧库版本的测试；保留业务测试。新建库只走新基线。
3. 将 Store 改为异步 Gateway DB 调用，事务内完成查询重复项、合并收藏／备注／分类、删除源条目及结果读取。检查所有 last_insert_rowid 依赖，使用同次执行返回值或 RETURNING，不能换连接查询。
4. 重排 Service 的锁、监控和 napi 调用：不可持同步 Mutex 跨 await；start 在 DB 与基线 ready 后执行，stop 异步等待在途采集退出，不能阻塞 main 的转发线程。保持原事件、去重、自身复制抑制及采集节奏。
5. 长文本大于 9999 字节落盘 `large_text/<hash>`，摘要为前 500 个 Unicode 字符。ReadText／copy／编辑读取全文，列表不读取文件全文，查询只匹配摘要和备注。保留 preview_truncated 的正确语义，不能用截短后的长度误判。
6. 写入与清理顺序覆盖长→短、短→长、长→长及重复合并。新文件持久写入成功后才能提交引用；旧文件只在提交成功且没有引用后删除。捕获／编辑并发不能互相删除附件；SQL 失败不损坏原记录及文件。删除／清空同步清理长文本，收藏保护不变。
7. 外部查看直接使用长文本持久文件，普通文本的临时导出按现有规则；不新建 UI、不改变页面样式。

## 验证与完成条件

- 临时库中的 CRUD、分类、收藏、备注、去重、分页、事件、复制和编辑合并全部回归；旧历史兼容测试删除，现有业务用例保留。
- 阈值边界与多字节文本、全文一致性、500 字符摘要、摘要外关键词不匹配、附件缺失、写盘失败、数据库回滚、所有长短互转和删除清理。
- 真实跨 native 的监控停止／调用取消／关闭次序，证明无锁反转和主线程死锁。
- 重建 Storage／剪贴板受影响 napi 包，运行 `pnpm gateway:test-native`、`just check`、`just test`。
- 不操作当前机器数据库；桌面生产验收依赖 03。若新接口使旧桌面接线无法编译，应在同次改动更新 03 的最小接线，禁止带着无法构建的中间状态交付或启动旧实例。
- 回填长期说明，删除本 Plan。
