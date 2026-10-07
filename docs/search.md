# 搜索实现

本文描述当前代码中的搜索行为。全局搜索由 `xiaowei-search` 提供，采用内存候选遍历、nucleo 模糊匹配、拼音匹配和使用记录加权；不使用 SQLite、FTS5 或倒排索引。迁移背景与验收结果见 [搜索迁移 record](../.agent/records/archived/2026-09-16-migrate-search.md)。

## Launcher 搜索入口

Launcher 提供可唤起的本地搜索窗口，输入与结果共用 [LauncherSearchBar](../desktop/src/renderer/src/components/LauncherSearchBar.tsx) 和 [Launcher](../desktop/src/renderer/src/components/Launcher.tsx)。迁移背景及原生验收结果见 [Launcher record](../.agent/records/archived/2026-09-16-migrate-launcher.md)。

空搜索窗口为 800 × 71，无边框、透明、置顶，不允许用户调整大小；有结果时按最多九行展开，行高 48px、行间距 4px，更多结果在列表内滚动。原生阴影关闭，圆角、边框和阴影由前端绘制；顶部 16px 为拖动区域，浅色和深色随系统或应用主题设置切换。

主入口快捷键切换当前模式窗口的显隐，不重置模式；模式专用快捷键在同模式已显示且聚焦时隐藏，否则切换并显示。快捷键默认值及自定义规则见 [桌面快捷键](shortcuts.md)。macOS 启动时保持隐藏，失焦隐藏，开发者工具打开时保留窗口；普通关闭隐藏而非销毁，应用退出才销毁。Tray、Dock 与来源焦点归还的细节见 [焦点管理事项](../.agent/records/active/2026-09-28-tray-dock-focus.md)。

默认位置为鼠标所在屏幕工作区的水平居中、距顶部 15% 高度处。同屏再次唤起保留拖动位置；跨屏时，默认位置重新计算，手动位置按两个工作区比例映射。双击 Logo 恢复默认位置；定位实现见 [launcher-shortcuts.ts](../desktop/src/main/windows/launcher-shortcuts.ts)。

搜索框挂载时聚焦，再次获得窗口焦点时全选输入。Esc 清空并隐藏；输入法组合期间不处理 Esc、方向键或回车。上下键选择结果，回车执行，单击选中、双击执行；键盘滚动保留上下 8px 余量。空查询按下方向键打开快速对话；入口与窗口交互见 [Quick Chat](../desktop/docs/quick-chat.md)，运行能力由 Agent Chat 事项维护。

查询改变时保留上一轮非空列表及窗口高度，待当前查询返回后替换；清空立即收起结果。旧响应不能覆盖新查询，等待结果或已有执行进行时不能执行旧条目。renderer 通过 typed Launcher Gateway 调用，preload 只暴露通用 `gateway`，不提供任意 IPC；结果执行权限见下方「桌面执行边界」。

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

- [desktop/src/main/services/launcher/gateway.ts](../desktop/src/main/services/launcher/gateway.ts)：读取书签搜索开关，调用 Search，保存动作并执行结果。
- [gateway.rs](../crates/xiaowei-search/src/gateway.rs)：注册 Rust Search handler，通过 `spawn_blocking` 执行查询，转换契约结果。
- [lib.rs](../crates/xiaowei-search/src/lib.rs)：持有数据源、生成内存候选、调用评分、截取和合并结果。
- [搜索引擎](../crates/xiaowei-search/docs/search-engine.md)：包内匹配、拼音、高亮、截取与使用加权。

核心逻辑不依赖 Electron；napi 负责原生模块接入，构建与平台约定见 [Rust 模块通过 napi 接入 Electron](../crates/README.md)。

## 数据源与初始化

| 来源 | 匹配字段 | 生命周期与边界 |
| --- | --- | --- |
| 应用 | 本地化名称、别名及这些字段的拼音 | `xw-app` 扫描目录；当前应用搜索仅支持 macOS。目录事件防抖 500ms 后全量重扫，更新派生候选 |
| macOS 系统设置 | 名称、别名及拼音 | 随应用候选加入，provider 同为 `app`，执行系统设置 URL |
| Chrome 书签 | 标题、URL、标题拼音 | 默认 Chrome Default profile，合并读取 `Bookmarks` 与 `AccountBookmarks`；监听目录中两个文件的创建、更新和删除，相关事件防抖 300ms 后重载。查询可关闭书签参与 |
| 内置命令 | 名称、别名、名称拼音 | 每次查询生成当前可用命令 |
| 计算器 | 输入表达式 | 独立求值，不参与模糊评分 |

应用和书签的数据变化通知用于重建内存候选。这里的“索引”是内存候选与派生匹配串，不是全文索引；内部持有和查询方式见包内搜索引擎文档。

应用本地化名称替代显示名称时，原名称保留为别名；应用按稳定键去重。

书签合并时按原始名称、URL、文件夹路径去除完全重复项，标题为空时使用 URL；同 URL 的不同书签条目保留不同结果 ID，但共享使用记录。`Bookmarks` 或 `AccountBookmarks` 缺失视为该来源为空，两者均缺失时清空候选；任一文件发生其他读取或解析错误时，保留上次完整快照，初次加载失败则为空。目录监听覆盖 Chrome 原子替换文件的保存方式，并将符号链接目录解析为真实路径后匹配文件事件。

桌面窗口加载后延迟 1 秒调用 `initializeSearch()`，在后台初始化数据源并保留文件监听。预热和首次非空查询共用同一次初始化；退出时取消未触发的预热定时器。内部初始化与串行查询规则见 [搜索引擎](../crates/xiaowei-search/docs/search-engine.md#引擎与入口)。

查询先去除首尾空白。空查询返回空结果，不触发初始化；Gateway 拒绝超过 4096 字节的查询，核心入口对超限查询返回空结果。

## 包内搜索算法

查询采用 nucleo 模糊评分与拼音匹配，按来源截取候选后应用最近使用加权，再合并为展示结果。具体公式、高亮区间、候选上限、命令与计算器行为统一维护在 [搜索引擎](../crates/xiaowei-search/docs/search-engine.md)，不在此重复定义。

## 桌面执行边界

Electron main 按调用上下文保存最新一轮 token 和结果 ID → 完整结果映射。renderer 只接收标题、provider、label、基础分、高亮和图标 URL 等展示字段；执行时提交 token 与 ID，由 main 回查动作。新查询开始即清除旧动作，旧查询响应不能覆盖新查询结果，过期结果不能执行。

普通 URL 仅允许 HTTP(S)，系统设置 URL 仅允许来自应用 provider。打开应用、URL、复制计算结果及执行主题／重启命令后隐藏窗口；打开剪贴板命令返回模式切换结果。宿主只执行白名单中的命令与上述动作，renderer 不能提交任意路径或 URL。

## 图标资源

搜索响应返回展示用 `iconUrl`，不返回应用路径，也不等待图片读取。main 将路径登记为 `xiaowei-icon://app/<opaque-key>` 资源 URL；renderer 使用普通 `img` 和默认图标回退，不通过业务调用读取图标。

应用图标通过 App.ReadIcon 调用 `xw-platform` 的 macOS 图标提取能力，使用 `NSWorkspace.iconForFile` → TIFF → PNG，不使用 `app.getFileIcon`。图片请求到来后，main 先查询一周有效的磁盘缓存，缺失或过期时才提取。并发请求共享读取 Promise，完成后释放内存中的图片引用，失败可重试。URL 路径映射随应用 Gateway 关闭而释放，磁盘缓存跨启动复用。资源协议和缓存分别由 [protocol.ts](../desktop/src/main/resources/app-icons/protocol.ts) 与 [cache.ts](../desktop/src/main/resources/app-icons/cache.ts) 实现。

磁盘缓存位于 main 路径配置的 `appIcons`（应用数据目录下的 `cache/app-icons/`），以应用绝对路径的 SHA-256 命名 PNG。有效期从文件 mtime 起算，读取不续期；过期后按需覆盖，不定时扫描。仅合并进行中的请求，不保留已完成的内存图片缓存；提取失败不缓存，磁盘读写失败不阻断当前提取和显示。缓存按需填充，不迁移旧缓存或全量预热图标。

## 与剪贴板搜索的边界

当前全局搜索只提供“打开剪贴板”的命令，不召回剪贴板历史内容。剪贴板面板通过 Storage 的 [ClipboardDao::list](../crates/xiaowei-storage/src/clipboard_dao.rs) 对数据库文本／摘要、备注和文件路径进行 FTS5 查询；多词 AND、末词前缀匹配，收藏、类型和分类过滤发生在分页前，按最近使用时间、ID 降序返回。

Storage 另提供 `ClipboardDao.Search`，默认最多 100 条（允许指定 1–100），按 FTS5 相关性返回 entity 和最多 32 个 FTS token 的无高亮标记片段。此接口已可供内部调用，但全局 Search 尚未调用，也没有 nucleo 重排。长文本仅索引数据库摘要，不扫描完整文件。业务索引、触发器和回填见 [剪贴板全文索引与召回](../.agent/records/active/2026-09-17-migrate-local-clipboard.md#剪贴板全文索引与召回)，底层注册见 [Storage 数据库实现](../crates/xiaowei-storage/docs/database.md#fts5-与分词器注册)，模块分工见 [共享存储接入](storage.md)。

## 验证入口

搜索核心与 napi 验证入口见 [Search README](../crates/xiaowei-search/README.md#验证)；Launcher、图标缓存、桌面装配及跨 addon 联调见 [桌面测试](../desktop/tests/README.md)。修改 Rust 实现后的原生构建与运行实例验证遵循仓库 AGENTS.md。
