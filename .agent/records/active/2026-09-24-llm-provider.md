# 基于 Pi 的 LLM provider

## Why

Quick Chat 后续需要模型调用、流式事件、工具、取消和推理内容。用户决定复用成熟的 Pi 模型调用库，并希望通过现有 Gateway 让 TypeScript 的模型生态与 Rust 的 agent／会话能力协作，而不是迁入旧版 `xw-llm` 的自有 HTTP、SSE 和 WebSocket 实现。

## What

建立可供后续 Quick Chat 运行时使用的 Pi provider 边界。最终需能按当前设置选择模型和凭据，处理请求、流式文本／推理／工具调用、使用量、结束／错误与取消，并经 Gateway 供 Rust agent 调用。按用户要求一次只推进一个小切片；当前只核对接口并确定首个可独立验证的适配单元。

本事项不接入 Quick Chat 产品 UI，不改变会话数据，也不以直接模型调用代替旧 agent 的工具与恢复语义。UI 入口预览另见 [Quick Chat UI 事项](2026-09-24-quick-chat-ui-interaction.md)。

## How

旧版源码位于 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，核对时 HEAD `a45f5cd1ba197c76ae6b528d30f382f7080a5100`。旧 `xw-agent-runtime` 通过 Rust `ChatProvider::stream` 接收 `ChatRequest`、`StreamEvent`，`xw-agent-protocol`／rollout 也复用 `xw-llm::types`。采用 Pi 后需保留必要的领域数据语义，并建立 Rust↔TS 适配；不能直接把 TypeScript 库实现为 Rust trait。

当前 Gateway 已支持 TypeScript owner、Rust caller 和双向响应流，但尚无 LLM 业务契约。main 的目录规则和现有文件归属维护在 [Electron main 模块组织](../../../desktop/src/main/README.md)。Pi provider 的目标位置为 `desktop/src/main/services/llm/`，由 `app/gateway.ts` 装配和关闭；本阶段不新增 Rust crate 或 npm workspace package。后续 Rust agent 经 Gateway 调用该 owner；具体业务契约需根据旧事件处理和 Pi 输出逐字段核对后决定，特别是交错的文本／推理／工具块、工具参数 JSON、取消、使用量、错误和推理回放。

`@mariozechner/pi-ai` 与 `@earendil-works/pi-ai` 是同一 Pi 项目的旧／新发布名，并非两个并行分支：旧 GitHub 地址 `badlogic/pi-mono` 重定向到 `earendil-works/pi`，两个地址当前指向同一提交；旧 npm 包已标记弃用并提示改用新包。后续使用 `@earendil-works/pi-ai`。用户给出的本地 DSH `/Users/changtang/Develop/LLM/deepseek-harness` 已使用新包（目前锁定 0.85.1），其 `packages/llm/llm-pi-ai/` 是 DSH 自己的适配层，可参考 `src/context.ts`、`stream.ts`、`provider.ts` 的映射，不复制 Cordis、凭据或会话系统。当前尚未在本项目安装依赖。

现有设置模型页仍是 Storybook mock；提供方配置、Key 获取和模型目录由后续切片衔接。Pi 的协议名与设置页的 `openai-completions`、`openai-responses`、`anthropic-messages` 一致，但能力、上下文上限和输出上限需有明确来源。旧版与 Pi 在重试、Responses WebSocket、推理回放和错误细节上的差异要逐项验证并记录。

### 已完成的 main 边界整理

剪贴板的业务 handler、资源解析与临时导出、占用统计、设置订阅、监听启停、自动粘贴与保留期限调度均由 Rust `xiaowei-clipboard` 持有。TS `services/clipboard/` 已删除，`app/gateway.ts` 仅负责实例与 endpoint 装配，初始化后调用 `startServices()`，关闭 endpoint 时先停止后台服务和监听，再清理临时资源；失败时也显式关闭 history。

Rust 先订阅 SettingsChanged，再读初始快照，避免初始化漏掉变化。启动 30 秒后开始清理，之后每次完成后等待一小时；保留期限变化立即清理，-1 跳过；保持当前普通记录定义（非收藏、无分类、无备注）与附件删除逻辑。监听及权限请求响应已提交设置，与旧版 Rust 的事件驱动方式一致；后台失败记日志，不把已提交设置回滚。初始设置加载失败会使启动失败并回收订阅。任务串行执行，关闭等待在途工作结束，避免清理依赖已经关闭的 Storage。

Select 保留原 Gateway caller，先复制并更新使用信息，经 System.HideWindow 隐藏调用方窗口并在 macOS 让出应用焦点，然后读取自动粘贴设置；开启时等待 100ms，由 Rust 发送粘贴键。普通 Copy 不隐藏或粘贴；无辅助功能权限时保留已复制内容并请求权限。macOS 粘贴实现及已有 core-foundation／core-graphics 依赖从 napi 层移至业务核心，没有新增 crate 或 npm package。

Settings 的校验、持久化和协调归 Rust。开机启动通过 System.SetAutostart，快捷键通过 Shortcuts.Apply（TS owner 位于 services/shortcuts），保留调用方权限；宿主操作失败或数据库写入失败时恢复旧值，成功持久化后才发布 SettingsChanged。原 settings apply 的 TS/napi 回调已移除，不再保留 services/settings/。ShortcutConfiguration 沿用现有 Settings 契约消息，避免改变已使用的消息全名。

迁移范围与偏差：旧版 cleanup.rs 同时执行附件完整性扫描和缓存用量更新；当前仅迁移已有过期清理调度，占用量继续按请求实时统计。完整性标记、image flow 等尚未接入，不能称为全面对齐旧版。本次沿用旧版每轮完成后等待一小时的顺序；不再使用 TS setInterval 允许清理重叠的方式。

## Alternatives considered

- 迁入旧 `crates/xw-llm/` 的协议实现：用户已明确选择复用 Pi，不再推进此方案。
- 在 renderer 中直接调用模型：无法保住当前 main／Gateway 的调用与凭据边界。

## Current work

已完成 main 的应用、窗口、资源与现有 TS service 目录整理；已独立注册 System.OpenUrl，Launcher 网页打开经 Gateway 复用该服务；已补齐本地路径打开／定位契约并接入现有调用方；已将剪贴板资源处理迁回 Rust；占用统计、保留期限调度、监听设置及 Select 已迁回 Rust；TS settings 副作用回调已改为按能力划分的 Gateway service，本切片实现与自动验证完成；下一步回到 Pi 边界核对。当前只保留 [01 Pi provider 边界核对](../../plans/2026-09-24-llm-provider/01-provider-boundary.md) 一个活动 Plan。完成后回填本 record、删除 Plan，再取实现切片；不并发推进 UI 工作。

## Outcome

已核对旧 Rust `ChatProvider` 调用入口、当前 Gateway 双向流能力、Pi 公共流事件与 DSH 适配层，并确认 Pi 包从 `@mariozechner/pi-ai` 改名为 `@earendil-works/pi-ai`。尚未定义 LLM 业务契约、安装 Pi 依赖或发送真实模型请求。

用户确认前端能力统一通过 proto service／Gateway；Electron 系统 API 由 TS System service 提供；剪贴板资源处理和占用统计归 Rust 剪贴板模块，缺失数据库信息由 Storage 提供。已将该决定及 main 全部现有文件的目标归属写入组织文档；已完成源码目录整理和启动／窗口／设置副作用拆分，保持现有业务契约与行为；System.OpenUrl 已从剪贴板 owner 中拆出；本地路径打开／定位已接入 System，剪贴板资源处理已迁回 Rust，统计与调度尚未迁移。

main 目录整理已通过 30 个 desktop Node 测试、3 个 Gateway 桌面测试、2 个生命周期／Select 测试、`just check` 与 desktop 构建。当前工作区没有运行实例，未执行冷启动；窗口运行交互仍待用户启动后验收。

合入最新 develop 后已重新通过 desktop 测试（30 个 Node、64 个组件用例）、Gateway 桌面及生命周期回归、全仓检查与桌面构建，并完成全部 napi 包 debug 构建。

System.OpenUrl 切片保持现有 HTTP(S) 协议限制，不扩大为通用 scheme 打开能力。Launcher 复用原调用 client，浏览器打开失败时不记录使用量、不隐藏窗口；系统设置专用 URL 仍仅接受 app 搜索来源。该切片不修改 proto、Rust 或 UI。

System.OpenUrl 切片已通过 `just check`、29 个 desktop Node 测试、4 个 Gateway 桌面测试、完整 `pnpm gateway:test-native` 和 desktop 构建。URL 验证测试从剪贴板辅助函数迁至 System Gateway 测试，覆盖无剪贴板初始化、与原生主题方法共存、非法 URL、宿主失败及关闭后不可调用。尚未执行本切片的真实桌面浏览器打开验收。

本地路径切片新增 System.OpenPath／RevealPath，共用 LocalPathRequest；System 校验绝对路径、NUL 字节和目标存在性。剪贴板仍在 TS 解析记录、管理临时导出，仅通过原 client 调用宿主能力；Launcher 应用启动移除 bootstrap 的 openPath 回调。已核对旧版 clipboard/commands.rs 的 open_file_path／open_large_text 和 search/commands.rs 的 LaunchApp；本次保持当前资源处理与默认应用打开方式，未宣称完成 Rust 迁移。

本地路径切片已完成 `just gen` 并通过 `just check`、契约三语言 codec 检查、Gateway 桌面行为测试、完整原生联调及 desktop 构建；三个 napi 包均已重建。用临时文件验证路径合法性、文件／目录打开、定位和宿主错误；真实 OS 应用打开与文件管理器定位仍待运行验收。

确认当前工作区活实例归属后执行 `just rs`，17:13:25 新 Electron 进程启动，原生日志、剪贴板监听和 renderer 初始化正常；具体文件打开／定位交互仍待人工验收。

资源迁移切片：Rust `resources.rs` 持有私有临时目录和原子文本导出，复用既有 tempfile 依赖（从测试依赖提升为运行依赖）；普通文本使用内容 SHA-256 命名，重新打开覆盖可能被外部修改的导出内容，图片／大文本复用原附件。关闭 endpoint 或显式关闭未完成初始化的 history 时清理导出，停止监听不清理。资源 handler 通过调用方的 Gateway client 访问 DAO 和 System，拒绝越权嵌套请求。复制路径经新增 System.WriteClipboardText 继续使用 Electron 的跨平台剪贴板；已删除 TS 资源解析实现。统计和保留期限调度仍在 TS。

资源迁移验证：Rust 剪贴板 17 项测试、desktop Node 26 项测试、完整 Gateway 原生联调（含资源处理、权限拒绝和初始化中止清理）、契约 codec 与 desktop 构建通过。临时目录权限已显式保持 Unix 0700，文件保持 0600；全仓检查需在 napi 产物事务结束后执行，避免扫描构建中的临时文件。

构建事务结束后 `just check` 已通过。确认当前工作区进程归属后执行 `just rs`，17:23:19 新进程加载三个工作区 .node，剪贴板监听、renderer 和搜索初始化正常；真实外部应用打开／Finder 定位仍待人工操作验收。

占用统计切片：新增 `xiaowei.storage.Storage.DatabaseUsage`，由现有 Storage endpoint 报告自身数据库／WAL／SHM 的文件长度总和；Rust 剪贴板保留原请求权限调用该契约，再在 blocking worker 递归汇总附件目录中的普通文件。缺失文件计零，其他文件系统错误向上传递，不跟随符号链接；保持整个共享数据库加附件的原口径，不做业务空间分摊。TS 统计实现及数据库路径参数已移除，临时导出文件不进入附件目录。

统计切片已通过 Rust 剪贴板／Storage 41 项测试、desktop Node 25 项测试、完整原生联调及新增占用统计跨语言测试、三语言 codec 和桌面构建。覆盖 WAL／SHM、缺失文件、目录递归、符号链接、附件删除、导出不计入附件及权限／Storage 关闭错误传播。

统计切片的 `just check` 已在构建结束后通过；确认工作区实例归属并执行 `just rs` 后，17:29:46 新进程加载三个原生模块，剪贴板、renderer 和搜索初始化正常。设置页实际空间显示仍待人工验收。

HMR 修复已于本轮前经用户人工验收：设置页热更新后，加载设置和刷新存储空间未发现异常。相关约束在 renderer、main README 及 Biome 中维护。

本轮完整边界迁移已通过 Rust 剪贴板／Storage 43 项测试、desktop Node 26 项测试、完整 Gateway 原生联调、三语言契约 codec、desktop 构建和 `just check`。新增回归覆盖：30 秒初次清理及小时周期、重复启动／关闭、永久保留、收藏保护、关闭后停止清理，Select 的复制／隐藏／粘贴顺序与失败短路，以及 Settings 嵌套调用权限和宿主失败回滚。三个 napi 包均完成重建。

确认当前工作区活实例后执行 `just rs`，18:11:04 新 Electron 进程加载三个工作区原生模块，Rust 设置订阅启动、剪贴板监听和 renderer／搜索初始化正常。真实自动粘贴与焦点恢复、修改快捷键和开机启动仍需用户人工验收；未在用户系统上自动切换这些设置。main README 已移除业务细节与历史进度，只保留能力归属、装配、生命周期和开发导航约定。
