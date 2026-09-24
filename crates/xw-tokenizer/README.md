# xw-tokenizer

内部 SQLite FTS5 分词模块，由 Storage 注册到每条数据库连接，不依赖业务实体、Gateway 或 napi。

- `tokenize='xiaowei std'`：中文建索引使用 Jieba `cut_for_search`，查询使用 `cut`；英文数字按连续字母数字分词，统一小写。
- `tokenize='xiaowei char'`：保留旧版非 ASCII 字符分词与标点过滤行为，不适合英文文件路径索引。
- `unsafe register(db)`：调用方必须持有有效 SQLite 连接的独占访问权；返回 SQLite 状态码。不注册进程级自动扩展。

Jieba 固定到用户公开 fork 的 commit，保留预构建 Yada 词典。C 桥接使用 `DEP_SQLITE3_INCLUDE` 提供的 bundled SQLite 头文件，不另存头文件副本；与 Storage 固定同一 `libsqlite3-sys` 版本。

来源为 `xiaowei-next/crates/xw-tokenizer`，保留分词行为及原测试；改为逐连接注册、检查 FTS5 API 可用性并保留 token callback 的错误码。FTS 桥接将重叠展开子词标记为同位置，避免索引子词破坏查询词组的连续位置；索引与 snippet 辅助分词保持一致。设计及验证见 [FTS5 record](../../.agent/records/active/2026-09-24-fts5-search.md)。
