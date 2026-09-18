# 04：Electron 接入与现有业务通信迁移

主事项：[实现核心 Gateway 通信机制](../../records/active/2026-09-18-implement-gateway.md)。依赖 00、01、02、03。本计划范围已由用户确认，尚未实施。范围只替换通信，不重新设计业务或 UI。

## 文件与职责

| 文件／目录 | 修改内容 |
| --- | --- |
| `gateway/ts/src/main/`、`src/preload/`、`src/renderer/` 与 package exports | 可复用 Electron 适配和分环境入口；默认入口与 renderer 依赖链不引入 Node／Electron |
| `desktop/src/main/gateway.ts` | 装配唯一 main gateway 实例、接入窗口／frame 上下文和应用生命周期 |
| `desktop/src/preload/gateway.ts` | 使用包内 preload 适配暴露统一通道，不暴露 ipcRenderer |
| `desktop/src/preload/index.ts`、`src/shared/gateway-api.ts`、renderer `env.d.ts` | `window.gateway` 与现有业务 facade 的类型和实现 |
| `desktop/src/main/index.ts`、`search.ts`、`clipboard.ts` | 启停顺序、main handler 注册、移除已迁移的业务 IPC listener |
| 两个 Rust 业务包 `src/gateway.rs` 及 napi 接入文件 | typed 业务 handler 与现有服务实例绑定，复用业务方法 |
| `desktop/package.json`、`electron.vite.config.ts`、锁文件 | TS gateway workspace 依赖和打包；browser client 不引入 native 包 |
| `desktop/scripts/`、gateway 测试目录、现有 napi 测试 | 传输契约、兼容 facade、订阅竞态和打包验证 |
| `docs/workspace.md`、`docs/rust-napi.md`、主 record | 当前有效入口、调用示例、模块接入与退出约定 |

## 路由迁移表

最终 route 名在业务契约中集中声明并生成绑定，以下为计划映射；不能在多层复制独立字符串列表。

| 当前接口 | 计划 route／event | owner 与职责 |
| --- | --- | --- |
| `window.launcher.search/execute/icon` | `launcher.search`、`launcher.execute`、`launcher.icon` | main 保留结果 token、窗口上下文和系统打开动作；内部调用 native 搜索 route |
| `window.launcher.hide/resize` | `launcher.hide`、`launcher.resize` | main 处理窗口；facade 保留 void 签名并处理异步错误，resize 保序以免旧尺寸覆盖新尺寸 |
| 搜索 napi 业务方法 | `search.query`、`search.readAppIcon`、`search.recordUsage`、`search.toggleSystemTheme` | 搜索 Rust owner；初始化／日志回调属于生命周期，不硬塞进业务 RPC |
| 剪贴板列表、详情、读文本／图片、复制、删除、收藏、清空、备注、编辑及分类 | `clipboard.<现有方法名>` | 剪贴板 Rust owner，引用唯一 Service，参数校验覆盖所有入口 |
| `clipboard.resource/openUrl` | 同名 route | main 的 Electron 文件／系统应用适配；通过 gateway 获取业务数据 |
| `clipboard:changed` | `clipboard.changed` | 剪贴板 owner 显式导出，Coalesce 失效通知；订阅后重新查询快照 |

`clipboard.list` 等是 Rust owner，`clipboard.resource` 是 main owner，共享 namespace 不代表共享 owner，注册使用精确 route 名。不能注册 main 转发同名 route 又令 native 同名发布。

## 执行步骤

1. main 启动创建全局 gateway，准备 owner／窗口上下文；初始化日志，再接入 native endpoint 和业务实例，完成注册后创建窗口。数据目录继续来自 `paths.ts`，剪贴板仍持有现有数据库；搜索仍在启动延迟一秒后预热。
2. Electron 使用统一通信入口（invoke、subscribe、unsubscribe，以及 stream open／next／cancel）和私有 event 通道。内置 renderer 由宿主标为可信，无业务 route 白名单；不允许 payload 指定 trust、owner 或目标窗口。frame 身份和 generation 用于窗口动作／订阅归属，窗口重载、导航、销毁时清理旧订阅并取消活跃流。
3. `xwOn` 沿用旧版异步 ready 语义：本地 listener 与远端订阅都就绪才 resolve。使用订阅 ID 关联早到事件和有界初始化状态；取消发生在 subscribe 完成前也必须清理，不遗留 pending。多个订阅部分失败时清理已建立的订阅；不广播给所有窗口。
4. 保留 `window.launcher`、`window.clipboardHistory` 强类型 facade，内部使用生成的 client 走 gateway，React 组件不感知 Electron 传输。AsyncIterator 在 renderer client 内构造，不跨 contextBridge 传递。`onChanged` 原同步 disposer 需兼容异步订阅，并确保初次快照在订阅 ready 后读取，解决“初次查询与订阅建立之间丢失变化”的竞态；失败须可观察，不静默留下失效订阅。
5. 逐个迁移剪贴板 route，复用 Rust Service 方法和现有验证，不搬业务到 TS。不因可信策略去掉参数和业务校验。`readImage` 返回原始字节；资源操作保持路径、打开／定位语义。
6. 迁移搜索及窗口 route。保留搜索请求 token、过期结果拒绝、图标缓存和命令行为；窗口动作从宿主调用上下文确定窗口，Rust／main 缺少窗口上下文的调用不能隐式控制错误窗口。普通可信计算／数据库类 route 不要求窗口身份。
7. 统一退出：停止接收新调用和生产事件，停止剪贴板监听，注销 owner／订阅、取消活跃流，结束 pending、释放 native callback，然后关闭业务服务。renderer 重载不重复创建数据库或业务实例。
8. 移除迁移完的业务专用 IPC 注册，避免双路径重复执行；日志的 `console-message` 链路保持原有实现。gateway 不要求迁移与业务 RPC 无关的 Electron 原生机制。

## 绑定与流的接入验证

- 在 `contracts/proto/` 定义 launcher、search、clipboard 的实际接口，统一生成到语言契约包；desktop 和 Rust 模块依赖契约包，Gateway 绑定消费接口描述。删除被契约包替代的手写协议类型，保留领域模型和服务实现，不在各业务模块复制生成产物。
- `pnpm contracts:check` 进入 `pnpm check`，缺失或过期产物使检查失败；打包消费者只能导入已生成的 runtime，不依赖 codegen 在运行时执行。
- Electron 模拟传输与现有实例可用时的集成验收覆盖 renderer stream open／next／cancel、open 未完成即导航、pending next 中取消、终态后清理；不自动冷启动 Electron。fixture 不向正式产品注册 LLM route。
- 真实 native owner 经 main 向 renderer 交付生成类型的流，慢消费时各边界无预拉取积压；窗口销毁会取消生产者。测试需验证 contextBridge 只暴露普通 transport 方法，不能用绕过 bridge 的 Node 单测替代该边界验收。

## 验证与验收

- TS gateway 与 native 集成测试覆盖所有旧 facade 签名、错误及 bytes 返回值；共用真实 registry，传输采用可控 fake 进行窗口重载、迟到订阅、取消竞态测试。
- 搜索快速连续请求、过期 token、图标、切换主题和开发态 rs 保持语义；不得通过测试触发真实系统动作，以注入的 shell／window adapter 验证。
- 临时数据库验证剪贴板采集后列表、收藏、备注、分类、文本编辑、图片读取与事件；不写用户系统剪贴板，不迁移或重建用户数据库。
- 两个测试窗口／frame 的事件定向投递、窗口销毁清理；可信 renderer 可调用任意已注册业务 route，模拟不可信 caller 仅可用授权 route／event，不能借 native 转发提高权限。
- 执行 `just check`、`just test`；两个 napi 包重新构建后执行桌面 build 和 Storybook build，运行现有相关交互检查。此切片不新增 UI 状态，若发现必须改 UI，则先独立做 Storybook 并等用户确认。
- 打包验证新 TS 包可解析，现有两个 `.node` 仍在正确解包位置；不额外引入第三个 gateway `.node`。
- 确认现有 Electron 与 nodemon 属于当前工作区后 `just rs`，验证现有搜索／剪贴板链路。无运行实例时不自行启动；普通 Node 集成测试可独立完成，桌面验证列为待办。

## 完成与后续阶段

验收通过后，将实现边界和调用方式回填主 record／长期文档，删除本 Plan。Gateway 是独立的核心通信机制，不依赖 Storage；[Storage 独立事项](../../records/proposed/2026-09-18-introduce-storage.md) 承载 DB／KV／Config 的后续设计与实施，本切片不提前实现这些能力，也不能将通信接通描述为存储已经统一。
