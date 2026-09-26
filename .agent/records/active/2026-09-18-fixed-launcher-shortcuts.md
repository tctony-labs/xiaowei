# 固定搜索与剪贴板快捷键

## Why

用户要求通过 Cmd+Space 唤起搜索框、Cmd+Shift+X 唤起剪贴板，暂不实现设置中的自定义快捷键。此前桌面只有 Cmd+Alt+Space 显示／隐藏当前窗口，没有剪贴板快捷键。

## What

为已有搜索和剪贴板界面增加固定全局入口，复用现有组件、存储和搜索逻辑，不改变 UI，不新增设置或配置存储。用户明确本次不需要 Storybook，直接接入桌面。

## How

主快捷键默认 macOS `Command+Space`、其他平台 `Control+Alt+Space`，只切换当前窗口显隐，不改变搜索／剪贴板／快速对话模式；显示时聚焦当前输入框。剪贴板默认 `CommandOrControl+Shift+X`；快速对话使用 `CommandOrControl+Shift+C`，与剪贴板一致：同模式窗口可见且聚焦时隐藏，否则切到目标模式并显示、聚焦，跨模式时调整尺寸。主快捷键与剪贴板沿用设置中的自定义值。快速对话的设置入口仍隐藏，宿主在配置未提供该绑定时补上上述固定入口，启动和设置更新共用相同转换，不修改持久设置。所有模式顶部统一定位到鼠标所在屏幕可用区域高度的 15% 处，横向居中，不随结果列表或剪贴板面板高度改变，保证同一屏幕上快捷键唤起时左上角对齐。窗口在首次 `ready-to-show` 或双击任一模式搜索框的 Logo 时执行默认定位。快捷键、Dock 和第二实例唤起时重新获取鼠标所在显示器，与窗口当前主要所在显示器比较：跨屏时先迁移位置再显示、聚焦：原本处于默认位置时使用目标屏幕的默认位置，否则按工作区宽高等比例换算窗口水平中心和顶部的相对坐标，避免面板高度影响定位；同屏时保留原生窗口的拖动位置。macOS 在窗口创建后、绑定失焦事件和首次显示之前一次性启用跨 Space 可见；后续唤起仅定位、显示和聚焦，不重复设置跨 Space 可见。该设置持续保留，让窗口显示在当前桌面；失焦时仍按原有逻辑隐藏。不依赖 `will-move` 事件，不写入磁盘；重启创建新窗口时复原。重置 IPC 同样限定当前窗口主 frame。注册失败分别记录错误，不阻止另一个快捷键注册；退出时统一释放。

主进程通过 LauncherOpened Gateway 事件通知模式；renderer 的订阅不随模式切换重建，回调通过 effect event 读取最新 UI 状态，避免重订阅空档丢事件。renderer 通过 UpdateLayout 同步实际模式。跨模式切换时清空搜索，搜索／剪贴板复用输入框挂载聚焦和窗口重新聚焦时全选行为；快速对话展开和窗口重新聚焦时聚焦 composer，保留草稿及消息。

旧版参考 `xiaowei-next/xiaowei/src-tauri/src/biz/shortcut/mod.rs` 的 `launcher_shortcut_behavior`、`dispatch_action`，以及 `biz/search/commands.rs` 的 `open_launcher`、`toggle_launcher`；前端参考 `xiaowei/src/pages/launcher/LauncherPage.tsx` 的 `launcher:open` 订阅。旧版主快捷键只切换显隐并保留当前模式；最初按“拉起搜索框”要求将 Cmd+Space 指向搜索模式；2026-09-26 按用户要求改为保留所有模式、仅切换窗口显隐。

### 原生快捷键与微任务调度

全局快捷键直接执行业务 action，事件调度统一由 Gateway `DeliveryQueue` 负责：Node 使用 `setImmediate` 启动投递，浏览器保留 `queueMicrotask`。快捷键层不再包装回调；不依赖日志 I/O、额外延时或前端强制提交唤醒通知。实现约定见 [Gateway TS](../../../gateway/ts/README.md#事件与上下文)。

核对 Electron 44.3.0 及其 Chromium 152.0.7977.78／V8 对应源码：macOS 热键由 Carbon handler 直接进入 `GlobalShortcut::OnKeyPressed`，进而由 `V8FunctionInvoker` 调用 JS；主进程采用 `kExplicit` 微任务策略，Invoker 的 `MicrotasksScope(kRunMicrotasks)` 只会在 `kScoped` 策略下自动执行检查点。Electron 在 Chromium task observer 和 Node loop 回调中执行检查点，但原生热键回调本身不保证进入这些路径。Gateway 原先的 `DeliveryQueue.enqueue` 使用 queueMicrotask，因此通知可能等待其他任务推进；同步日志引入的 I/O 或诊断新增的 Node timer 可以掩盖该缺口。

源码依据：[热键回调](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_global_shortcut.cc)、[JS 调用封装](https://github.com/electron/electron/blob/v44.3.0/shell/common/gin_helper/callback.h)、[主进程微任务策略与 Node loop](https://github.com/electron/electron/blob/v44.3.0/shell/common/node_bindings.cc)、[Chromium task observer](https://github.com/electron/electron/blob/v44.3.0/shell/browser/microtasks_runner.cc)、[对应 V8 的 MicrotasksScope 析构](https://chromium.googlesource.com/v8/v8/+/3de6ffffbfdcf265e9f11a5c9d1cfb4d486d7550/src/api/api.cc)。

## Current work

2026-09-26 将调度修复收敛到 Gateway Node 事件队列，撤销快捷键业务层 setImmediate 包装，并移除全部临时采样、日志、前端对照开关和 flushSync 尝试。Gateway 回归模拟微任务检查点缺失，覆盖本地／远端事件、取消订阅和浏览器回退；旧实现失败，新实现通过。用户随后验证无调试日志版本的真实按键行为，明确确认卡顿已修复。

## Outcome

2026-09-26 用户确认加日志并重启后已不再卡顿，随后要求清理调试代码。已移除临时窗口／通知／renderer 耗时日志、计时变量及帧回调采样，保留快捷键、输入聚焦、无多余动画和稳定订阅修复。清理后 33 项相关测试、桌面类型检查和 Biome 通过。未采到卡顿现场，不能将现象消失归因于日志或确定性能根因。

已接入两个固定快捷键及模式通知，同步更新 Launcher 说明。移除了本次新增的 Storybook 预览，关闭了本工作区临时启动的 6007 服务，保留主工作区 6006 服务。

桌面类型检查、Biome、9 项 Node 测试及 Electron 构建通过；新增测试覆盖同模式显隐、隐藏／失焦唤起、跨模式调整尺寸并通知、无有效窗口时忽略。确认当前工作区 Electron、开发监听进程的绝对路径、cwd 及父子关系后执行 `just rs`；2026-09-18 16:33:55 的重启日志显示 main、renderer 与原生模块正常启动，未出现快捷键注册失败。用户随后确认功能正常，固定快捷键的桌面验收完成。自动测试使用窗口替身，原生按键行为以此次用户验收为依据。

修复了快捷键唤起位置随当前面板高度变化的问题，并根据用户反馈将默认位置从约三分之一高度上移到可用高度的 15%；回归测试覆盖收起搜索、展开结果及剪贴板三种高度，并包含负坐标副屏。桌面类型检查、10 项 Node 测试及构建通过，已对确认归属的当前工作区实例执行 `just rs`；本轮同时加入运行期间拖动位置保留、Logo 双击复原，重启不保留位置；原生拖动、双击及定位效果待用户复验。

用户复现拖动后失焦再按 Cmd+Space 回到默认位置，说明此前依赖 `will-move` 的坐标记录未可靠生效。已移除该依赖和每次唤起的定位，新增拖动→隐藏→搜索快捷键→剪贴板快捷键→显式复原的回归测试。类型检查、11 项 Node 测试和桌面构建通过；窗口替身测试不代替原生拖动复验。

唤起时现按鼠标所在显示器迁移窗口：同屏保留拖动位置，跨屏将默认位置映射到目标默认位置，非默认位置按两屏工作区宽高换算水平中心和顶部的相对坐标。新增回归覆盖默认／拖动位置、不同分辨率、负坐标副屏及三种面板高度；24 项桌面 Node 测试、类型检查、Biome 和桌面构建通过。确认当前工作区实例的路径、cwd 和父子进程关系后执行 `just rs`；实际多显示器效果待用户复验。

2026-09-23 首次尝试在显示、聚焦后立即关闭跨 Space 可见；用户启动本工作区后反馈窗口拉起即消失。当天日志显示应用正常启动，未记录对应的主进程错误。随后移除立即关闭跨 Space 可见的调用，保持窗口可在当前桌面显示；更新调用顺序回归测试。桌面 26 项 Node 测试、类型检查、Biome 与构建通过。确认当前工作区实例的绝对路径、cwd 和父子关系后执行 `just rs`，新 Electron 进程和 19:43:43 的启动日志确认已加载；原生跨桌面效果仍需用户复验。


2026-09-24 针对快速唤起时窗口出现后消失的问题，将 `setVisibleOnAllWorkspaces(true)` 从每次唤起移至窗口创建阶段。Electron 44.3.0 的 API 类型说明明确指出该调用默认转换 macOS 进程类型，每次调用会短暂隐藏窗口和 Dock；这与立即失焦隐藏组合，是本次修复针对的可疑触发路径，现有日志未记录焦点事件，尚未原生复现确认。连续唤起回归确保跨 Space 设置仅在初始化执行，保留同模式切换显隐、跨模式切换和跨屏定位。30 项桌面 Node 测试、类型检查、Biome 和桌面构建通过。当前没有 hermes 工作区实例，未执行重启；快速重复唤起搜索／剪贴板、跨 Space 唤起和点击外部隐藏待用户启动后复验。

2026-09-26 接入 Cmd+Shift+C 快速对话入口，主快捷键统一保留当前模式，并补上聊天重新唤起的输入聚焦。12 项快捷键测试、8 项 Launcher／QuickChatPanel 测试、桌面类型检查、Biome 和构建通过。核对当前工作区实例的路径、cwd 与父子关系后执行 just rs；14:02:45 新主进程启动，renderer 与原生模块加载正常，未见快捷键注册失败日志。原生组合键与焦点效果待用户复验。
