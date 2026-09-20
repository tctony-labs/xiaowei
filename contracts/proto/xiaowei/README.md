# 业务契约的创建与维护

这里的 proto 定义 XiaoWei 的业务能力和消息语义，是 TS／Rust 业务通信的唯一手写契约来源。消息生成、语言选择和工具版本见 [契约工程](../../README.md)；Gateway 的路由、权限和生命周期见 [Gateway](../../../gateway/README.md)。

## 按业务职责划分

先说明“调用方要完成什么、需要哪些信息、结果代表什么”，再设计 service 和消息。不要根据已有 crate、进程、napi 方法、IPC 通道或数据库表机械地建立 proto。

| 文件 / package | Service | 当前职责 |
| --- | --- | --- |
| `search.proto` / `xiaowei.search` | `Search` | 不依赖窗口的查询与排序使用反馈；向后端执行者提供有类型的动作 |
| `launcher.proto` / `xiaowei.launcher` | `Launcher` | 启动器交互会话：查询展示结果、按批次执行、窗口布局与打开通知 |
| `app.proto` / `xiaowei.app` | `App` | 应用能力，当前提供原始 PNG 图标读取 |
| `system.proto` / `xiaowei.system` | `System` | 系统主题切换、通过系统应用打开 http(s) 网页 |
| `clipboard.proto` / `xiaowei.clipboard` | `Clipboard` | 历史条目、内容读取／复制、收藏备注分类，以及条目关联的资源操作 |
| `database.proto` / `xiaowei.storage` | `Database` | 参数化 SQLite 查询、原子事务与 migration_v2 管理 |
| `common.proto` / `xiaowei.common` | 无 | 真正共用的消息，目前只有 `Empty` |

文件和 package 使用单数业务名，service 使用 PascalCase。service 与执行 owner 不要求一一对应：`Clipboard` 的 CRUD 在 Rust，资源打开／定位在 main，仍属于同一个业务服务；Gateway 按完整方法名路由。不得为区分 main／Rust 而重新建立 `ClipboardResources` 等服务。

`Search` 和 `Launcher` 的区别是能力语义：前者提供可复用搜索，后者管理当前窗口的结果批次、过期执行拒绝和显示状态。`Launcher.Query` 不是无意义转发，因此保留；仅重复取图标的 `Launcher.Icon` 已删除。主题切换不是搜索能力，网页打开不是剪贴板能力。

只定义当前已需要的能力。不要为了命名对称预建应用安装、枚举、通用文件系统、配置或存储接口。将来增加能力时重新检查归属，不把 `System` 或 `common` 变成杂物箱。

## 消息必须表达业务语义

- 字段名说明内容。使用 `query`、`url`、`recency_key`、`deleted_count`，不使用无法独立理解的 `value`。
- 相同标量类型不代表相同语义。不要为少写消息，把业务请求／结果统一包装为 `Text`、`Boolean`、`Count` 或无领域的 `ItemId`。同领域、同含义的条目 ID 请求可以复用。
- 响应说明操作结果。`SetFavoriteResponse.updated` 表示记录存在并被更新，不表示收藏后的状态；`DeleteResponse.deleted` 表示是否删除；`ClearHistoryResponse.deleted_count` 不计受保护的收藏。
- 固定集合使用 enum，零值为 `UNSPECIFIED`。执行端拒绝不支持或未知的枚举值，不能默认为一个具有副作用的操作。
- 互斥且具有不同 payload 的操作使用 `oneof`。搜索动作不再使用 `action_type + action_value` 两个字符串。不要用万能 `action` 字符串代替含义明确的 RPC。
- `optional` 必须有明确语义。例如 `SetCategoryRequest.category_id` 缺失表示取消分类；列表过滤缺失表示不筛选。不要把缺失、零值和 null 混为一谈。需要三态时显式定义。
- 单位、范围、默认值、空结果及错误行为写在字段／方法注释中。时间使用 Unix 毫秒的 `int64 *_at_ms`；ID 使用 `uint64`，剪贴板领域限制为正的有符号 64 位范围。
- Protobuf 负责 wire 格式和类型，不替代业务验证、权限检查和参数限制。TS 静态类型不能保证运行时输入合法。

## 避免暴露实现细节

`ClipboardItem` 是历史摘要：`preview_text` 可能截断，`preview_truncated` 明确指出这一点；完整内容使用 `ReadText`／`ReadImage`。文本是否存为大文本、图片在磁盘上的缓存路径，不属于页面契约。条目资源打开、定位、复制路径由后端根据记录解析，调用方不提交任意磁盘路径。

`LauncherHit` 只携带展示字段和可选 `icon_url`，不携带执行动作或应用路径。搜索生成图标 URL 时不读取图片；浏览器请求 URL 后，由 Electron 资源处理器异步读取和缓存。前端直接使用 `<img src>`，不根据“这是 app”再调用图标 RPC。确实需要原始图标数据的模块仍可使用 `App.ReadIcon`。

开发模式是宿主初始化配置，不由每次搜索请求决定。窗口身份、信任级别和 owner 身份属于 Gateway 上下文，不能通过业务 payload 自行指定。

## 绑定与调用

实际路由由 `package.Service.Method` 生成，例如 `xiaowei.clipboard.Clipboard.List`，不复制手写路由别名。事件使用 message full name，且必须由 owner 显式导出。

renderer 只通过 `window.gateway` 访问通用 transport；`services.ts` 的 `getClipboard()`、`getLauncher()`、`getApp()`、`getSystem()` 首次使用时绑定，之后缓存，并共享一个 renderer client。import 不连接 Electron 或绑定所有服务。Storybook／测试注入独立 client，不保留旧 `window.clipboardHistory`／`window.launcher` facade。

同一 service 分属多个 owner 时，TS 显式使用 `bindHandlers(..., { partial: true })` 注册本 owner 的方法；默认全量绑定仍检查缺失 handler。Rust 使用生成的具体 Method 注册。禁止两个 owner 发布相同 route；应用装配和集成测试需覆盖完整业务调用。

## 修改流程与兼容性

1. 核对能力归属、调用方和现有业务行为，明确消息的参数、结果、默认值与副作用。新契约不能以通信迁移为由偷偷改变存储或 UI 行为。
2. 修改手写 proto；新增 namespace 后补 TS／Rust 包入口。Go 只按服务端需要加入 `contracts/generate.config.json`，不强制生成全部本地业务。
3. 执行 `pnpm contracts:generate`。Rust Gateway 绑定另外执行：

   ```sh
   cargo run -q -p xw-gateway --example generate_business -- search > crates/xiaowei-search/src/gateway_bindings.rs
   cargo run -q -p xw-gateway --example generate_business -- clipboard > crates/xiaowei-clipboard/src/gateway_bindings.rs
   ```

   当前 search 原生包承载 Search、App、System 的原生方法，是部署事实，不决定契约归属。
4. 同步更新 handler、调用方、类型、测试和长期文档；契约与实现不能分开交付。涉及 Rust 时重建受影响的 napi 包。
5. 执行生成一致性、类型和相关行为测试；覆盖缺失值、未知 enum／oneof、ID 边界，以及更新／删除未命中等语义。涉及订阅时验证 ready 后取快照、卸载清理和迟到响应；涉及资源 URL 时验证搜索不读取图标、延迟读取、失败和缓存。

已发布字段的编号不得复用，也不得在原编号上替换不兼容类型。删除字段时保留 `reserved` 编号和不再使用的名称；兼容加字段与破坏性升级区分处理。未发布的同批重设计可以同步切换全部消费者，不为旧内部 API 留无用兼容层，但仍保留废弃字段编号，防止误用旧二进制。

兼容性由消息语义和 wire 规则决定，不用“重新生成成功”代替判断。生成产物统一由工具维护，不人工检查或修改排版；生成一致性检查仍必须执行。
