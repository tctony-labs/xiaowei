# 基于 Pi 的 LLM provider

## Why

Quick Chat 后续需要模型调用、流式事件、工具、取消和推理内容。用户决定复用成熟的 Pi 模型调用库，并希望通过现有 Gateway 让 TypeScript 的模型生态与 Rust 的 agent／会话能力协作，而不是迁入旧版 `xw-llm` 的自有 HTTP、SSE 和 WebSocket 实现。

## What

建立可供后续 Quick Chat 运行时使用的 Pi provider 边界。最终需能按当前设置选择模型和凭据，处理请求、流式文本／推理／工具调用、使用量、结束／错误与取消，并经 Gateway 供 Rust agent 调用。按用户要求一次只推进一个小切片；当前只核对接口并确定首个可独立验证的适配单元。

本事项不接入 Quick Chat 产品 UI，不改变会话数据，也不以直接模型调用代替旧 agent 的工具与恢复语义。UI 入口预览另见 [Quick Chat UI 事项](2026-09-24-quick-chat-ui-interaction.md)。

## How

旧版源码位于 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，核对时 HEAD `a45f5cd1ba197c76ae6b528d30f382f7080a5100`。旧 `xw-agent-runtime` 通过 Rust `ChatProvider::stream` 接收 `ChatRequest`、`StreamEvent`，`xw-agent-protocol`／rollout 也复用 `xw-llm::types`。采用 Pi 后需保留必要的领域数据语义，并建立 Rust↔TS 适配；不能直接把 TypeScript 库实现为 Rust trait。

当前 Gateway 已支持 TypeScript owner、Rust caller 和双向响应流，但尚无 LLM 业务契约。main 的目录规则、现有文件归属和剪贴板职责调整统一维护在 [Electron main 模块组织](../../../desktop/src/main/README.md)。Pi provider 的目标位置为 `desktop/src/main/services/llm/`，由 `app/gateway.ts` 装配和关闭；本阶段不新增 Rust crate 或 npm workspace package。后续 Rust agent 经 Gateway 调用该 owner；具体业务契约需根据旧事件处理和 Pi 输出逐字段核对后决定，特别是交错的文本／推理／工具块、工具参数 JSON、取消、使用量、错误和推理回放。

`@mariozechner/pi-ai` 与 `@earendil-works/pi-ai` 是同一 Pi 项目的旧／新发布名，并非两个并行分支：旧 GitHub 地址 `badlogic/pi-mono` 重定向到 `earendil-works/pi`，两个地址当前指向同一提交；旧 npm 包已标记弃用并提示改用新包。后续使用 `@earendil-works/pi-ai`。用户给出的本地 DSH `/Users/changtang/Develop/LLM/deepseek-harness` 已使用新包（目前锁定 0.85.1），其 `packages/llm/llm-pi-ai/` 是 DSH 自己的适配层，可参考 `src/context.ts`、`stream.ts`、`provider.ts` 的映射，不复制 Cordis、凭据或会话系统。当前尚未在本项目安装依赖。

现有设置模型页仍是 Storybook mock；提供方配置、Key 获取和模型目录由后续切片衔接。Pi 的协议名与设置页的 `openai-completions`、`openai-responses`、`anthropic-messages` 一致，但能力、上下文上限和输出上限需有明确来源。旧版与 Pi 在重试、Responses WebSocket、推理回放和错误细节上的差异要逐项验证并记录。

## Alternatives considered

- 迁入旧 `crates/xw-llm/` 的协议实现：用户已明确选择复用 Pi，不再推进此方案。
- 在 renderer 中直接调用模型：无法保住当前 main／Gateway 的调用与凭据边界。

## Current work

已完成 main 的应用、窗口、资源与现有 TS service 目录整理；已独立注册 System.OpenUrl，Launcher 网页打开经 Gateway 复用该服务；已补齐本地路径打开／定位契约并接入现有调用方；已将剪贴板资源处理迁回 Rust；下一步迁移统计和调度，再接 Pi。当前只保留 [01 Pi provider 边界核对](../../plans/2026-09-24-llm-provider/01-provider-boundary.md) 一个活动 Plan。完成后回填本 record、删除 Plan，再取实现切片；不并发推进 UI 工作。

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
