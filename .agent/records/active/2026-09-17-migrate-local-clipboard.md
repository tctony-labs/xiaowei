# 迁移本地剪贴板逻辑

## Why

复用旧版 Rust 剪贴板能力，建立 Electron 可调用的本地历史链路，去掉 Tauri 与公司服务依赖。

## What

本轮实现 macOS 文本（含长文本）、图片、文件路径采集，500ms 监听、去重、SQLite 持久化、分页与文本检索、按 ID 读取、复制回系统剪贴板、删除／清空普通历史和本地收藏。接入 main 生命周期与受限 preload API，本轮补充搜索入口和基础剪贴板面板，产品与 Storybook 共用组件。

## How

`crates/xiaowei-clipboard` 是纯 Rust 业务入口，`napi/` 提供 npm 包；Electron 仅负责生命周期、日志与 IPC。旧版参考：`xiaowei-next/crates/xw-domain/src/clipboard/` 的数据类型、toolkit、hash、storage，以及 `src-tauri/src/biz/clipboard/monitor.rs`。系统 I/O 复用 arboard、macOS changeCount 和文件 URL 的方式，业务规则保留空白过滤、内容去重、重复使用更新时间和次数、复制后的自身事件抑制。

SQLite 数据库统一位于 `userData/xiaowei/storage.sqlite`，由 Storage 持有连接池；剪贴板通过 Gateway 执行业务 SQL，不再自行打开数据库。图片按旧版 `storage.rs` 在采集时由 Rust 写入 `userData/xiaowei/clipboard/images/<hash>.png`，数据库只保存哈希、尺寸等元数据，返回的 `imagePath` 由目录和哈希推导。图片读取、复制回系统剪贴板均读取原文件；打开、定位和复制路径也直接使用原文件，退出应用不删除。相同哈希复用文件，删除记录时尽力删除附件；清空普通历史保留收藏及其图片。文件历史只保存路径，不复制用户原文件。

已确认的技术与行为偏差统一记录在下方「待对齐差异」中。这些差异不代表用户批准了替代方案，也不代表已完成全面核对；无法按旧版实现时须报告原因与影响，不能擅自更换技术方案。

基础检索按文本、备注和文件路径进行字面子串匹配，按最近使用顺序返回。收藏仅为本地标记；普通历史不上传。暂不自动清理历史，等待后续明确保留策略。数据库当前不加密，端到端同步的密钥设计不在本轮范围。

main 就绪后打开数据库并启动监听，退出时停止线程；初次轮询会读取当前剪贴板。通过 changeCount 避免重复读取，读取前后版本不同则下次重试。连续相同内容忽略，内容再次出现时复用已有记录并更新使用时间和次数；复制历史记录时抑制自身回写造成的重复计数。文件 URL 优先于文本读取，每个文件独立写入一个 NSPasteboardItem。

renderer 通过 `getClipboard()` 的 typed Gateway client 调用 `list`、`get`、`readText`、`readImage`、`copy`、`setFavorite`、`delete`、`clearHistory`。`clearHistory` 保留收藏；`copy` 仅复制，不向前台应用模拟粘贴。`onChanged` 返回取消订阅函数，通知只表示数据已变化，可能合并，调用方应重新查询。IPC 限制当前窗口主 frame，校验 ID 和查询参数；列表每页最多 100 条，查询最多 4096 字节。超过 9999 字节的文本标记为 `largeText`，列表／元信息保留最多 500 字符预览，完整内容用 `readText` 获取。

存储和系统 I/O 由 Rust 串行处理，napi 异步任务不在 JS 主线程执行数据库操作。搜索和剪贴板原生模块复用内部 `xw-napi-log` 日志接收器，各自注册回调后汇入现有 main 日志。修改后执行 `pnpm --filter xiaowei-clipboard build:debug` 生成原生产物，再按运行实例规则重启。

UI 以旧版源码为准：`xiaowei/src/pages/launcher/{LauncherPage.tsx,modes.tsx,components/LauncherSearchBar.tsx}` 和 `pages/clipboard/{ClipboardBody.tsx,components/CategoryNav.tsx,components/ItemList.tsx,components/Preview.tsx}`。产品和 Storybook 共用 `ClipboardPanel`，`ClipboardPage` 负责 IPC、变更订阅及预览／缩略图 Blob URL 回收。原版 FileTypeIcon、ContextMenu、Modal 和剪贴板 SVG 图标按需迁入，颜色映射到当前主题变量。

- 800 × 580 窗口；搜索框内模式标签「剪切板」，不新增返回栏；保留已确认的搜索栏右侧 16px Logo 边距。
- 默认导航顺序为收藏、剪贴板、图片、文件，初始选中剪贴板；32px 导航按钮、上下 12px 留白。图片／文件筛选由 Rust 在 SQL 分页之前执行，不能只过滤当前页面。
- 左栏 312px、40px 列表行、4px 行距、20px 文件类型图标／图片缩略图；收藏星标可取消收藏；选中底色恢复旧版浅色 `#E2FEF1`、深色主色 20% 透明度。
- 右栏内容、底部图标工具栏、默认折叠的详细信息按旧版排列；文字支持原始／JSON／Markdown 切换，图片适应预览区，文件卡片展示公共目录和数量。长文本显示摘要并隐藏「查看 MARKDOWN」入口，保留 JSON 查看；「查看全部文本」调用系统默认文本应用打开完整 UTF-8 内容。用户已确认 Storybook 预览，该行为已接入实际页面。
- 单击选中；回车／双击复制后隐藏 launcher；右键复制仅复制并保留窗口。自动粘贴仍属后续事项，当前相当于旧版关闭自动粘贴的行为。
- 上下键选择，空输入左右键循环切换默认分类；Esc 或空输入 Backspace 返回全局搜索；IME 合成时不执行这些快捷操作。非空查询 150ms 防抖，空查询立即清除；合成期间不请求搜索。
- 删除先显示原版确认弹窗，Esc 只关闭弹窗；右键菜单的 Esc 只关闭菜单。列表按旧版最多显示 200 条，不添加“加载更多”按钮；内部通过每页 50 条读取。变更通知重新读取显示范围并保持选中 ID。
- 文本编辑、备注、分类管理和记录归类已接通原版弹窗／菜单。分类支持名称、颜色、重命名、删除；删除分类仅将记录改为无分类。列表显示备注副标题及分类角标，左右键包含自定义分类。图片理解入口不展示。UI 仍有下列明确缺口，不宣称完整迁移或已经通过用户视觉验收。

初始 schema 使用 `clipboard_items` 和 `clipboard_categories`，包含备注和分类字段，开启外键，以 `ON DELETE SET NULL` 保留分类删除后的记录。文本编辑更新全文、类型和完整哈希；编辑成已有内容时保留目标记录、删除来源记录，收藏取 OR，不同备注按旧版以分号合并，分类优先采用来源记录，刷新使用时间和次数。全文、备注和分类的写入失败会保留编辑弹窗及草稿并显示错误；不会写入系统剪贴板。备注可以清空，空白正文拒绝保存。

新增 napi／preload API：`editText`、`setRemark`、`setCategory`、`categories`、`saveCategory`、`deleteCategory`；列表按 `categoryId` 在 SQL 分页前筛选。改动通过统一变更事件通知其他界面，编辑后的同 ID 预览也会重新读取全文。

npm 依赖使用可从公网获取的包，禁止引入 `@tencent` 下无法从公网安装的依赖。Modal、ContextMenu、图标来自旧项目本地源码，未依赖 `@tencent/xiaowei-react-ui`。

文件／图片的右键菜单支持打开、在文件夹中查看和复制路径；多文件记录保留全部文件复制及逐个文件卡片操作，同目录时提供复制文件夹路径。main 只接受记录 ID、操作类型和可选文件序号，再从 Rust 读取真实路径／内容，不允许 renderer 提交任意本地路径。打开多个文件须选择单个卡片；定位多文件记录逐个交给系统文件管理器。Markdown 链接通过 main 校验 HTTP／HTTPS 后调用系统浏览器；渲染模式允许远程 HTTP／HTTPS 图片，图片请求不携带 Referer，CSP 仅放开图片来源。

图片操作不再经过临时导出；复制路径跨应用重启有效，直到对应记录／文件被删除。修复前复制的临时路径需重新复制。长文本全文持久保存于 `clipboard/large_text/<hash>`，数据库只保留前 500 字符摘要，外部查看使用持久文件；普通文本仍按需临时导出。采集、读取、编辑、长短转换、重复项合并及删除同步维护文件，旧附件在数据库提交成功且无引用后清理。长文本搜索匹配摘要和备注，不扫描文件全文。

选中行滚入视口时仅滚动左侧列表，上下保留 8px 留白；首尾行利用列表原有 padding 保持相同间距。

## Current work

本地逻辑和基础面板已实现；已确认当前工作区运行实例并执行 `just rs`。真实系统采集、图片／文件回写和视觉对齐仍待桌面人工验收。

在 launcher 搜索「剪贴板 / clipboard」（也支持拼音）并回车进入面板，检查四个默认分类、搜索、预览、右键复制、删除确认和详情展开。Esc 或空输入 Backspace 回到全局搜索；面板回车／双击复制并隐藏窗口，不自动粘贴。复制文本、截图和 Finder 文件后可通过界面检查，也可在应用 DevTools 中执行 `await window.clipboardHistory.list({ limit: 10 })` 检查记录，再以对应 ID 验证 `readText(id)`／`readImage(id)`、`copy(id)` 和 `setFavorite(id, true)`。关闭并重新启动应用，确认记录与收藏保留。图片复制应在图像应用中粘贴检查，文件复制应检查多文件路径；自动化测试没有改写用户的系统剪贴板。

## Outcome

- 已实现独立 Rust 业务包、napi 包、SQLite 存储、macOS 监听与 Electron 生命周期／preload 接口。新增 Rust 内置剪贴板命令，在现有 launcher 中打开基础面板；剪贴板记录本身尚未作为全局搜索结果来源。
- `just check`、`just test` 通过；覆盖 72 项 Rust 测试、7 项 napi 测试和 3 项桌面日志测试，Go 检查与测试入口通过。新增验证包括跨进程持久化、去重、分页、收藏、清空保留收藏、自身回写抑制、失败重试、监听停止、PNG 编解码及独立命名 pasteboard 的多文件 URL 往返。
- 搜索与剪贴板 `.node` 均已重新构建，桌面构建及 macOS ARM64 未签名目录打包通过；检查两个原生模块均进入解包资源目录，并使用普通 Node 加载打包后的剪贴板模块验证临时数据库读写。尚未执行真实桌面采集验收。

- 搜索入口／UI 增补：`just check`、3 项 Rust 命令检索测试、桌面构建和 Storybook 静态构建通过。Headless Chrome 运行 `KeyboardAndActions` 和 `OpenClipboard` 的 play 检查通过；检查了深色面板截图。搜索原生包重新构建后，对已确认归属的当前实例执行了 `just rs`。浏览器测试采用模拟 IPC，真实桌面操作仍需人工验收。

- UI 纠偏：移除自行设计的返回栏、顶部文字按钮和常驻使用次数栏，恢复旧版模式标签、默认分类、底部图标工具栏、折叠详情、右键菜单、删除确认和快捷键。Rust 类型过滤测试及 napi 测试通过，Storybook 浏览器检查覆盖原有动作、分类循环、菜单复制、删除取消与确认、详情折叠和空输入返回；检查明暗主题截图，仍待用户对照旧版验收。

- 本地编辑补齐：文本／长文本编辑、去重合并、备注及备注搜索、分类增删改和记录归类已实现。新增重启持久化、合并元数据、删除分类保留历史的 Rust 测试；新增 napi 编辑链路测试及 Storybook `EditingAndCategories` 全操作场景。检查未引入 `@tencent` 私有 npm 包。

- 外部资源操作补齐：图片／文件菜单、文件卡片菜单、长文本外部查看、Markdown Web 链接与远程图片已接通。Node 测试验证完整 UTF-8 导出、图片原文件路径、编辑后路径变化、并发原子写入、文件序号约束和 URL 协议校验；Storybook `ResourceMenus`、`MarkdownWebContent` 交互检查通过，浏览器通过拦截测试图片响应确认解码加载。检查及桌面／Storybook 构建通过；未自动打开用户的外部应用，实际默认应用和 Finder 定位需桌面验收。

- 图片存储纠偏：恢复采集时持久落盘和按记录清理；Rust 测试覆盖元数据保留、跨重启路径和收藏清理边界，Node 测试验证图片直接使用原文件。Storybook `SelectionScrollPadding` 覆盖连续向下／向上选中及首尾行 8px 留白。`just check`、14 项 Rust 测试、3 项 napi 测试和 6 项桌面测试通过，原生模块已重新构建。确认当前工作区实例归属后执行 `just rs`；只读核验图片记录有对应持久文件。

## 待对齐差异

以下为对照旧版源码确认、尚未修正的差异。记录不等于实施或接受当前方案；本清单也不是完整对齐验收结论。

| 项目 | 旧版行为／方案 | 当前实现与影响 |
| --- | --- | --- |
| 去重哈希 | 带类型前缀的 MD5；文本使用长度与截断内容，大图使用元数据与采样内容，文件路径用逗号拼接 | 完整内容 SHA-256，文件路径使用长度分隔；去重规则、哈希值和图片文件名均不同。图片持久落盘已修正，但哈希规则未对齐 |
| 数据库访问及结构 | SeaORM 管理业务数据，搜索使用 SQLx；使用旧版实体与迁移结构 | 已改为 [Storage](2026-09-18-implement-storage.md) 统一持有 SQLx pool，业务通过 Gateway 执行 SQL，迁移采用 migration_v2 新基线；不引入 SeaORM，表名使用 clipboard 前缀。这是已明确的重构方案，本机切换验收待 Storage 最后切片完成 |
| 搜索 | FTS5、自定义分词、空白分隔的多词匹配和末词前缀匹配，按最近使用排序 | SQL 子串匹配，将整段查询作为一个匹配字符串；检索语义和性能未对齐。此前已记录为后续工作，不在本次记录操作中实施 |
| 分类顺序 | 按创建时间倒序，新建分类在前 | 按 ID 升序，新建分类在后，影响分类导航及菜单顺序 |
| 编辑后的使用次数 | 编辑成尚不存在的新内容时更新时间但不增加使用次数；内容不变或合并时走 `bump_use` | 编辑成新内容时也增加一次使用次数 |
| 更新时间 | 独立保存 `update_date`，编辑正文、切换收藏等操作维护相应更新时间 | 只有创建时间和最近使用时间，没有独立更新时间字段，无法表达同样的元数据语义 |

核对来源（相对于旧项目 `~/Develop/XiaoWei/workspace/src/xiaowei-next`）：

- `crates/xw-domain/src/clipboard/storage.rs`：长文本文件、图片文件、编辑、收藏、分类与元数据行为。
- `crates/xw-domain/src/clipboard/hash.rs`：类型前缀、MD5、截断／采样和文件路径哈希规则。
- `crates/xw-domain/src/clipboard/search.rs`：SQLx、FTS5 查询与排序。
- `crates/xw-domain/src/clipboard/types.rs`、`crates/xw-core/src/path.rs`：长文本摘要、类型与持久目录。

图片文件存储、原文件路径操作及按记录清理已经修正，结果见 Outcome；本节列出的其余差异仍待处理。此前明确暂缓的功能列在下一节，不能与迁移时擅自引入的技术偏差混为一谈。

## 后续工作

- 设置：监听开关、保留周期、容量统计与上限、来源排除规则。用户于 2026-09-20 将设置入口明确为“清理全部”：复用自动清理规则，将截止时间设为点击时的当前时刻，清理该时刻之前的全部普通数据，不按保留天数回推截止时间。普通数据须同时满足未收藏、无备注、无标签等保护标记；任一保护标记存在即保留。本轮仅在 Settings Storybook 中预览，业务实现暂缓；现有 `clearHistory` API 删除所有未收藏历史并保留收藏，语义不同，预览不调用它。
- 同步、登录、密钥与加密：仅同步收藏，普通历史留本机。
- 图片理解：OCR、caption、图片向量索引／语义检索。
- 独立快捷键、自动粘贴到前台应用。
- 图片 OCR／描述元数据不伪造，随图片理解事项实现。
- 旧版自定义 FTS 分词和全文索引。
- 定期过期清理、文件失效状态检查。
- 旧版数据库和附件迁移：按用户 2026-09-20 确认的方案，改为离线一次性迁移，对最终用户不可见；不提供设置入口或面向最终用户的迁移进度、结果界面。当前只移除了 Settings 预览中的迁移 UI，离线迁移逻辑尚未实现。此事项与当前应用数据库的 schema 自动升级分别处理。
- 来源应用信息、富文本／HTML 格式保真，以及 Windows／Linux 系统剪贴板接入。
