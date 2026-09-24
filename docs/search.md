# 搜索实现

本文描述当前代码中的搜索行为。全局搜索由 `xiaowei-search` 提供，采用内存候选遍历、nucleo 模糊匹配、拼音匹配和使用记录加权；不使用 SQLite、FTS5 或倒排索引。迁移背景与验收结果见 [搜索迁移 record](../.agent/records/active/2026-09-16-migrate-search.md)。

## 模块与调用链

```text
Renderer → Launcher Gateway（Electron main）
         → Search Gateway（Rust / napi）
         → SearchEngine
             ├─ xw-app：应用与系统设置候选
             ├─ xw-bookmark：Chrome 书签候选
             ├─ commands：内置命令
             └─ calculator：表达式计算
```

- [desktop/src/main/search.ts](../desktop/src/main/search.ts)：读取书签搜索开关，调用 Search，保存动作并执行结果。
- [gateway.rs](../crates/xiaowei-search/src/gateway.rs)：注册 Rust Search handler，通过 `spawn_blocking` 执行查询，转换契约结果。
- [lib.rs](../crates/xiaowei-search/src/lib.rs)：持有数据源、生成内存候选、调用评分、截取和合并结果。
- [scoring.rs](../crates/xiaowei-search/src/scoring.rs)、[pinyin.rs](../crates/xiaowei-search/src/pinyin.rs)、[usage.rs](../crates/xiaowei-search/src/usage.rs)：共享匹配、拼音及使用加权。

核心逻辑不依赖 Electron；napi 负责原生模块接入，构建与平台约定见 [Rust 模块通过 napi 接入 Electron](rust-napi.md)。

## 数据源与初始化

| 来源 | 匹配字段 | 生命周期与边界 |
| --- | --- | --- |
| 应用 | 本地化名称、别名及这些字段的拼音 | `xw-app` 扫描目录；当前应用搜索仅支持 macOS。目录事件防抖 500ms 后全量重扫，更新派生候选 |
| macOS 系统设置 | 名称、别名及拼音 | 随应用候选加入，provider 同为 `app`，执行系统设置 URL |
| Chrome 书签 | 标题、URL、标题拼音 | 默认 Chrome Default profile；监听文件所在目录，相关事件防抖 300ms 后重载。查询可关闭书签参与 |
| 内置命令 | 名称、别名、名称拼音 | 每次查询生成当前可用命令 |
| 计算器 | 输入表达式 | 独立求值，不参与模糊评分 |

应用和书签使用 `Arc<RwLock<Vec<_>>>` 保存候选。数据变化后重建对应候选及拼音字符串。这里的“索引”是内存数组与派生匹配串，不是全文索引；每次搜索仍遍历全部启用的应用和书签候选。

应用本地化名称替代显示名称时，原名称保留为别名；应用按稳定键去重。书签标题为空时使用 URL；同 URL 的不同书签条目保留不同结果 ID，但共享使用记录。书签重载失败时保留旧数据，初次加载失败则为空。

桌面窗口加载后延迟 1 秒调用 `initializeSearch()`，在后台初始化数据源并保留文件监听。预热和首次非空查询共用 `SearchService` 的 `OnceLock<Mutex<SearchEngine>>`，仅初始化一次；提前搜索会初始化或等待正在进行的初始化。查询在后台阻塞任务中持有 engine mutex。同一服务的查询串行执行。退出时取消未触发的预热定时器。

查询先去除首尾空白。空查询返回空结果，不触发初始化；Gateway 拒绝超过 4096 字节的查询，核心入口对超限查询返回空结果。

## 匹配与基础评分

所有应用、书签和命令共用 `FuzzyScorer`，配置为 `nucleo-matcher` 的 `Config::DEFAULT` 加 `prefer_prefix = true`，并使用 `Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart)`。查询按 nucleo pattern 语义解析；不是 SQL 子串查询，也不是 Jieba 分词查询。

匹配忽略大小写，允许非连续字符命中，例如 `gh` 命中 `GitHub`。靠近字符串起始位置的命中获得前缀偏好。一个条目的名称、别名、URL、拼音等匹配串分别评分，取原始分最高者；原始分相同时取字符数更短的匹配串，然后增加长度修正：

```text
基础分 = nucleo 原始分 + 4 × 查询字符数 / max(命中字符串字符数, 1)
```

字符数按 Unicode 码点计算。长度修正用于偏好覆盖比例较高的匹配，不是跨文档统计。同一条目的多个字段不拼接、不累加分数；必须存在一个匹配串满足 pattern。

单条结果的基础分只依赖查询、自身匹配串和配置，与其他文档的数量、词频、平均长度无关。其他文档会影响最终名次及是否进入候选上限，但不会改变该条目的基础分。

## 拼音与高亮

含基本汉字区间 `U+4E00–U+9FFF` 字符的名称会生成全拼和首字母匹配串，例如 `周报` → `zhoubao` / `zb`，`Q3周报` → `q3zhoubao` / `q3zb`。多音字逐字展开，分支上限为 32，每个分支生成全拼和首字母，因此去重前最多 64 个匹配串。读音先排序再展开，不做上下文读音消歧。

实际启用拼音匹配的条件是：查询不含上述基本汉字，且至少包含一个 ASCII 字母；不是严格要求查询所有字符均为 ASCII。直接输入中文时使用原文匹配。

最终结果才计算标题高亮。原文和标题拼音候选使用同一 nucleo 配置，通过命中下标及字符归属映射，生成标题的 Unicode 码点区间 `[start, end)`，排序、去重并合并连续区间。例如 `weixin` 命中“微信读书”时只高亮“微信”。如果仅 URL 或不展示的别名命中，而标题及其拼音不匹配，可以没有标题高亮。

## 候选截取与最终排序

1. 应用和书签各按基础分降序、同分按标题排序，分别保留前 20 条。
2. 命令使用相同规则保留前 10 条。
3. 按命令、书签、应用的顺序合并，对各条目应用使用加权。
4. 按加权分稳定降序排序，保留前 30 条；同分保留合并前顺序。
5. 为这些结果计算高亮；如果表达式计算成功，把计算器结果插到首位，再截取至 30 条。

```text
排序分 = 基础分 × (1 + 0.6 × 使用因子)
使用因子 = 时间衰减 × 频次系数
时间衰减 = 0.5 ^ (距上次使用毫秒数 / 14 天毫秒数)
频次系数 = 0.5 + 0.5 × (1 - 1 / (1 + 使用次数))
```

无使用记录时因子为 0；刚使用一次时因子约为 0.75，频繁使用时趋近 1，排序分最高趋近基础分的 1.6 倍。记录保存在内存中，重启清空。结果成功执行后记录使用，计算器不记录；书签按 URL、应用按稳定键、命令按命令 ID 区分记录。

候选截取发生在使用加权之前，因此加权不能把某来源基础分前 20／10 名之外的条目重新带回结果。返回给调用方的 `SearchHit.score` 是基础分，实际列表顺序使用加权分；计算器的 score 为 0，但固定置顶。

## 内置命令与计算器

| 命令 | 可用范围 | 动作 |
| --- | --- | --- |
| `clipboard` | 所有当前实例 | 打开剪贴板模式，支持 clipboard、粘贴板、剪贴板历史等别名 |
| `toggle-system-theme` | macOS | 切换系统明暗主题，支持主题、深色、dark、theme 等别名 |
| `rs` | 开发实例 | touch 当前桌面目录的 `.rs`，触发现有 nodemon 构建与重启流程，支持 reload／rebuild 别名 |

开发命令可用性取决于宿主传入的 development 状态，不取决于 Rust debug/release 编译模式。命令通过 Electron 白名单执行。

计算器使用 `evalexpr`，提供 `pi`、`e`、`phi` 及对应大写常量，允许输入末尾带 `=`。仅接受有限数值结果，忽略纯数字输入以及布尔、字符串等结果；执行动作是复制计算结果。

## 桌面执行边界

Electron main 按调用上下文保存最新一轮 token 和结果 ID → 完整结果映射。renderer 只接收标题、provider、label、基础分、高亮和图标 URL 等展示字段；执行时提交 token 与 ID，由 main 回查动作。新查询开始即清除旧动作，旧查询响应不能覆盖新查询结果，过期结果不能执行。

普通 URL 仅允许 HTTP(S)，系统设置 URL 仅允许来自应用 provider。打开应用、URL、复制计算结果及执行主题／重启命令后隐藏窗口；打开剪贴板命令返回模式切换结果。显示交互及图标缓存说明保留在 [搜索迁移 record](../.agent/records/active/2026-09-16-migrate-search.md)。

## 与剪贴板搜索的边界

当前全局搜索只提供“打开剪贴板”的命令，不召回剪贴板历史内容。剪贴板面板通过 Storage 的 [ClipboardDao::list](../crates/xiaowei-storage/src/clipboard_dao.rs) 对数据库文本／摘要、备注和文件路径进行 FTS5 查询；多词 AND、末词前缀匹配，收藏、类型和分类过滤发生在分页前，按最近使用时间、ID 降序返回。

Storage 另提供 `ClipboardDao.Search`，默认最多 100 条（允许指定 1–100），按 FTS5 相关性返回 entity 和最多 32 个 FTS token 的无高亮标记片段。此接口已可供内部调用，但全局 Search 尚未调用，也没有 nucleo 重排。长文本仅索引数据库摘要，不扫描完整文件。业务索引、触发器和回填见 [剪贴板全文索引与召回](../.agent/records/active/2026-09-17-migrate-local-clipboard.md#剪贴板全文索引与召回)，底层注册见 [FTS5 能力](../.agent/records/active/2026-09-24-fts5-search.md)。

## 验证入口

- [核心集成测试](../crates/xiaowei-search/tests/search.rs)：搜索来源、排序与结果行为。
- `scoring.rs`、`pinyin.rs`、`usage.rs`、`commands.rs`、`calculator.rs` 内的单元测试：评分、高亮、拼音、使用加权、命令与表达式。
- [napi 测试](../crates/xiaowei-search/napi/test/)：原生绑定、预热与日志行为。

核心验证可运行 `cargo test -p xiaowei-search`；修改 Rust 实现后的原生构建与运行实例验证遵循仓库 AGENTS.md。
