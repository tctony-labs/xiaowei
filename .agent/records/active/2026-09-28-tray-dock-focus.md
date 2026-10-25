# Tray、Dock 与窗口焦点管理

## Why

实施前没有 Tray；启动、second-instance 和 app activate 都能显示 Launcher。快捷键收起只隐藏 BrowserWindow，可能留下应用焦点；System.HideWindow 则调用 app.hide()，可能连设置窗口一起隐藏。窗口显隐和焦点交接需要统一规则。

## What

用户于 2026-09-28 确认推进，直接创建 active record。用户于同日确认验收通过，实施完成，成果继续生效。范围为 macOS Tray、普通窗口的 Dock 展示与轮换、Launcher 唤起会话及焦点归还，覆盖剪贴板自动粘贴的交接顺序。Windows/Linux 保持现状，不承诺本轮实现对应的前台窗口恢复。

搜索、剪贴板、快速对话仍共用一个 Launcher；不增加业务窗口，不重写窗口基类，不迁移旧版插件和其他 Tray 业务。不改变既有快捷键配置、Esc 的模式内语义、输入状态和窗口定位规则。

## How

以下为当前实现的行为与约束；验证证据及其边界见 Outcome。

### Tray 与入口

- 开发态（`!app.isPackaged`）使用正式版 Tray 图标的水平镜像 `tray-dev.png`／`tray-dev@2x.png`（16px／32px）；正式版使用 `tray.png`／`tray@2x.png`。两者通过左右朝向区分，不添加文字或斜带，不改变图标尺寸。只保留实际使用的尺寸资源。此前尝试的原生文字、图内 `dev` 与斜带标记因尺寸或视觉效果不合适而弃用。

- 左键只显示并聚焦主窗口；已经在前台时无操作，不隐藏、不清空输入、不重置位置、不重复通知 renderer。保留当前搜索／剪贴板／快速对话模式。
- 右键菜单顺序为「搜索」「剪贴板」「快速对话」、分隔线、「设置」、分隔线、「退出」。前三项右侧展示当前已注册的配置快捷键，未配置时不展示；设置保留 `⌘,`。搜索与左键共用同一动作，名称不表示强制切回搜索模式；剪贴板和快速对话使用已有模式入口。菜单取消不改变窗口状态。
- `services/shortcuts/registry.ts` 统一持有全局快捷键与原回调；所有业务通过该注册表接入。打开菜单前临时注销全部绑定，由可见菜单项承担已展示的 accelerator，其余自动映射为允许快捷键生效的隐藏菜单项，避免重复。菜单关闭后按注册表当前内容恢复，退出清理后不再恢复已移除绑定；恢复失败保留错误日志。菜单期间新增绑定在下次打开时进入菜单快照，隐藏项不会执行已移除或替换的旧回调。
- 隐藏的主窗口仅由快捷键和 Tray 唤起。启动可以创建隐藏窗口并预热，不在 ready-to-show 自动显示；activate 与 second-instance 不回退显示隐藏的主窗口，可回到已参与普通窗口追踪的 Quick Chat。
- 同模式快捷键在主窗口可见且聚焦时收起；跨模式切换沿用同一次唤起的焦点来源。
- macOS 隐藏窗口唤起时先调用 `showInactive()`，让跨 Space 窗口在当前桌面显示，再调用 `focus()` 获取焦点。避免普通窗口 `show()` 在窗口仍隐藏时先激活整个应用，触发系统切回应用之前的桌面。跨 Space 属性仍只在创建时配置，并保留 `skipTransformProcessType: true`；Windows/Linux 沿用 `show()` 后聚焦。
- 用户实测：打开其他应用的 Tray 菜单时，主窗口保持可见、暂失输入焦点；关闭菜单后输入焦点回到搜索框。保留这一行为，不能将“暂失输入焦点”直接等同于 BrowserWindow blur 或外部 App 激活。沿用系统菜单行为，未加入定时隐藏／抢焦点补丁。

用户于 2026-09-28 确认将生成的统一加粗蓝绿 XW Logo 接入所有使用位置：`logo.png` 保留统一源图，应用内与 Tray 使用其预生成尺寸，`icon.png` 使用同一蓝绿造型加白色圆角底板的 1024px 版本作为各平台打包图标，macOS 开发态显式设置 Dock 图标，使开发态也能展示同一造型；正式包使用打包图标。

透明 Logo 的预生成资源位于 `desktop/resources/logo-sizes/`：Tray 使用 16px 和 `@2x` 32px，Electron 自动加载 Retina representation 并设置模板图，不再运行时 resize；22px／32px／80px 界面图标分别加载 44px／64px／160px 资源，Dock 使用带白色圆角底板的 `icon-512.png`。目录包携带该资源目录，完整源图仅用于资源维护与打包图标生成。菜单每次打开前按当前快捷键重建，并由 Tray 回调保留强引用。

PNG／ICNS 图标按传统 macOS 网格保留外部透明留白：1024px 画布中的白色底板主体为居中的 824px，四边各 100px；512px Dock 资源对应 412px 主体与 50px 留白。底板和内部 Logo 等比缩放，不改变内部比例。尺寸参考 [Apple 开发者论坛的传统图标讨论](https://developer.apple.com/forums/thread/670578) 的搜索摘要，并以本机 Calculator 图标的 256px 画布、206px 主体、25px 留白交叉核对；当前 [HIG](https://developer.apple.com/design/human-interface-guidelines/app-icons) 已转向 Icon Composer 分层图标，不将传统留白规则套用到分层输入。

### 普通窗口与 Dock

- 维护显式注册的普通窗口列表，包括设置窗口和可见的 Quick Chat；搜索／剪贴板、DevTools 和菜单不进入列表。Quick Chat 的模式与显隐规则见 [包内交互说明](../../../desktop/docs/quick-chat.md#产品入口与窗口交互)。
- 有已打开的普通窗口时显示 Dock 图标；最小化窗口仍计入。窗口加载失败或销毁后移除，最后一个普通窗口关闭后隐藏 Dock；可见临时弹层的隐藏延后规则见上述包内交互说明。未首次展示的加载中窗口不计入。
- 设置窗口沿用关闭即销毁；共用的 Launcher 在隐藏或切出聊天时由窗口 owner 显式移出追踪，重新显示聊天时再登记，登记时读取现有显隐与焦点状态。应用整体隐藏不能误当作设置窗口关闭。
- 从外部激活优先回到最近使用的普通窗口；应用内部连续点击 Dock 按注册顺序循环，最小化的候选先恢复。没有候选时不显示 Launcher。
- 自己维护最近聚焦窗口和轮换游标，不完全依赖事件回调时的 isFocused()。已接受的窗口切换只前移一个位置，不因 focus 事件重新排序列表。
- Dock show/hide 串行协调，只在目标状态变化时调用。完成较早的异步 show 不能覆盖较新的 hide 意图；不在每次 Launcher 唤起时切换 activation policy。
- Electron 44.3.0 会忽略 show 后一秒内的 hide。调用 hide 后若 Dock 仍可见，安排一秒后的状态重试；重试重新读取普通窗口列表，窗口状态变化会取消旧定时器，退出时清理定时器。快速关闭设置允许图标短暂停留，但不能永久残留；不绕过 Electron 防止重复 Dock 图标的保护逻辑。
- 用户固定在 Dock 的启动图标由 macOS 管理，不承诺删除固定图标。
- 取得单实例锁后初始化 Dock 隐藏状态；仅开发态（`!app.isPackaged`）在每次 `dock.show()` 完成后重新设置自定义图标，避免隐藏后再显示时恢复 Electron 开发宿主图标；正式包使用打包配置中的图标，不调用运行时 `setIcon`。启动时没有普通窗口，不单独设置 Dock 图标。Launcher 的跨桌面设置传入 `skipTransformProcessType: true`，避免 Electron 隐式显示 Dock；进程类型由普通窗口管理控制。开发态使用 Electron.app，主进程 JavaScript 执行前的系统启动图标仍由该开发宿主决定。

### 焦点会话与隐藏原因

主窗口从隐藏进入显示前捕获一次来源：自己的具体普通窗口，或外部应用及可用的外部窗口快照。内部模式切换、重复 Tray 点击、临时系统菜单不覆盖来源。会话结束及时释放原生引用。

| 原因 | 处理 |
| --- | --- |
| 快捷键收起、最终关闭整个主面板 | 隐藏主窗口，恢复本次唤起来源 |
| 用户主动切到别的窗口 | 搜索／剪贴板隐藏并结束会话；Quick Chat 保持显示，保留本次唤起来源，不在失焦时归还焦点 |
| 打开设置 | 交接给设置，不先恢复旧 App |
| 搜索打开应用／URL | 将焦点交给结果目标，不再恢复旧 App |
| 复制计算结果等无目标窗口的动作 | 收起并恢复来源 |
| 选择剪贴板记录 | 先复制并读取自动粘贴设置，再隐藏并等待来源恢复；确认成功后才允许自动粘贴 |
| 退出应用 | 取消待处理操作、释放引用，不执行焦点归还 |

同 App 来源直接恢复具体 BrowserWindow。外部 App 通过 macOS 原生能力激活；具备辅助功能权限且窗口仍有效时优先恢复具体窗口，否则降级到原 App 的当前窗口。焦点功能不主动弹权限申请。来源失效不重新启动应用，不选择任意窗口替代。待恢复期间用户主动切走或开始新会话，旧恢复操作作废。

剪贴板恢复失败、超时或被新操作取消时保留已复制内容，不向未知目标发送粘贴。跨进程确认与实际投递之间仍可能发生用户切换，验收需覆盖；不能把一次成功激活调用或固定 sleep 描述为可靠的焦点确认。

### 模块边界

Electron `windows/` 持有窗口列表、轮换和焦点会话；`app/tray.ts` 只管理 Tray 与菜单；`app/bootstrap.ts` 装配、退出清理；现有 Gateway owner 将调用方窗口交给窗口管理，不在 renderer 或 Rust 剪贴板中维护窗口策略。

为避免窗口管理依赖搜索或剪贴板业务，本事项通过新增平台入口接入焦点能力；用户已确认创建该入口。平台绑定现归 `xiaowei-rust`，通用实现仍归 `xw-platform`；职责、依赖方向和无状态接口约定统一维护在 [平台模块边界](../../../crates/xiaowei-rust/docs/platform.md#模块边界)，此处不重复维护。

本事项的 TS windows 层持有唤起来源、操作代次与取消状态。本轮不迁移 search／clipboard 中其他系统能力，不新增后台监听服务，不引入面向复用的发布流程。

### 旧版参考与差异

已核对本地 `~/Develop/XiaoWei/workspace/src/xiaowei-desktop`：

- `src/main/window/xiaowei-window.ts`：Set 管理窗口，updateDock 排除 main 与 fingerAssistantPanel，但 switchFocus 使用的可聚焦窗口集合没有相同过滤；只筛可见窗口，不能直接满足本轮最小化窗口规则。
- `src/main/main.ts`：activate 调用 switchFocus，无候选时显示主窗口。本轮移除该回退。旧版记录 Dock 显隐干扰焦点，并使用 200ms 标记；不直接复制该时间补丁。
- `src/main/window/focus-helper.ts`：通过私有包 AXUI 捕获窗口并执行 AXRaise。本轮不能依赖不可公开下载的包，需用公开 macOS API，增加无权限时的应用级恢复及同 App 分支。
- `src/main/tray.ts`：左键 toggle 与本轮只唤起规则不同；旧版其他菜单不迁移。

Electron 44.3.0 本地类型说明区分 activate 与 did-become-active：前者涵盖 Dock／重启入口，后者也会因 Cmd+Tab 触发。采用旧版 activate 接入和自维护窗口列表，未新增原生 reopen hook；真实多普通窗口事件时序的证据边界见 Outcome。

## Alternatives considered

- 统一 app.hide()：会隐藏仍需保留的设置等窗口，不采用。
- 所有 blur 都归还焦点：会干扰用户主动选择的窗口，不采用。
- 直接照搬旧版窗口基类与全局计时补丁：会带入主窗口轮换、空列表唤起和平台时序假设，不采用。
- 先实现任意深度焦点栈：当前只有一个临时主窗口，一次唤起会话足够，不采用。

## Outcome

用户于 2026-09-28 在收到自动验证结果和原生未验证项目清单后明确确认「验收 ok」。以用户验收结论完成当前事项收尾；三个实施切片已完成，删除对应 Plan，record 继续保留 active。

### 验证结果

- `just check`、`pnpm --dir desktop test`、25 项 xw-platform／clipboard Rust 测试、4 项 Gateway 桌面调用回归及平台 napi 快照释放测试通过。
- 最终菜单调整及 rebase 后的 21 项定向回归全部通过，覆盖 Tray 文案／动作、Launcher 启动隐藏与重复唤起、普通窗口轮换／最小化与异步 Dock 显隐、焦点来源保留和取消、HideWindow 等待确认／失败传播、快捷键失败回滚和生命周期清理。剪贴板 Rust 测试验证等待焦点恢复期间不发送粘贴。
- 桌面构建与 macOS arm64 未签名目录打包通过，包内 Tray 资源存在，平台 addon 可从 app.asar.unpacked 加载并提供焦点接口；未启动打包应用。
- 已核对当前工作区运行实例与重启后的日志，main、renderer、原生模块、剪贴板监听和搜索初始化完成；最后一次检查的启动时间为 11:57:56，未见该次启动后的 error／warn。
- 原生交互收尾依据用户验收确认。Agent 的 Electron UI 读取超时、Finder 截图为空白，未自行完成原生交互验证，不将 mock 测试描述为真实窗口验收。

### 菜单期间快捷键延迟修复

清理后桌面类型检查与 8 项 Tray／Launcher／快捷键定向回归通过。

用户补充复现菜单关闭后才显示窗口。17:22 两次日志中，250ms 计时探针约 252ms／251ms 执行，而快捷键回调分别在菜单关闭后约 20ms／3ms 才进入，之后焦点捕获仅约 56ms／37ms，排除整个 Node 事件循环停顿与焦点捕获阻塞。Electron 44.3.0 对应 Chromium 使用 Carbon 全局热键；原生菜单 tracking 期间热键投递延后，与 KeyboardShortcuts 库记录的行为一致。

最小实验临时注销 `Command+Space` 并交给菜单 accelerator。用户反馈「看上去正常了」；17:36:26.188 菜单搜索动作触发且全局注册恢复成功，17:36:26.257 收到窗口 show，未见积压的 toggle 回调重复触发。随后按用户要求扩展为统一注册表、加入剪贴板／快速对话菜单项、展示配置快捷键并增加分隔线。用户要求合并前清理日志，已移除临时诊断日志与计时探针，保留注册失败等错误日志；窗口与焦点捕获逻辑没有为此改动。

### 已接受的取舍与证据边界

用户补充「打开设置后立即关闭，Dock 图标不消失」。新增模拟 Electron 一秒隐藏保护的测试，旧实现稳定失败；增加隐藏后的状态检查与重试后，14 项普通窗口／Launcher 定向测试和桌面类型检查通过，覆盖快速关闭、等待期间重新打开及退出取消重试。此处测试验证协调逻辑，真实快速开关窗口的视觉结果仍待用户验证。

2026-09-28 补充修复启动／console 重启后无普通窗口仍显示 Dock：核对 Electron 44.3.0 的 `NativeWindowMac::SetVisibleOnAllWorkspaces`，默认参数会调用 `DockShow()`，而 `Browser::DockHide()` 会忽略 show 后一秒内的 hide；改为跳过隐式进程类型切换。12 项 Launcher／普通窗口定向测试和桌面类型检查通过。确认当前工作区实例归属后执行 `just rs`，17:54:29 启动日志正常，原生 `NSRunningApplication.activationPolicy` 实测为 accessory（1），符合无普通窗口时不显示 Dock 的策略。图标主体实测为 `824x824+100+100` 和 `412x412+50+50`；随后用户反馈 ready 前设置图标无效，打开设置仍显示 Electron 图标；已将设置时机改为 ready 后、服务初始化前，类型检查通过并重启开发实例。用户进一步确认 ready 后设置会短暂生效，但隐藏再显示后又恢复 Electron 图标。因此已改为每次 Dock show 完成后设置，移除启动时的一次性设置；15 项定向测试和类型检查通过，包含两次 show/hide 的图标重设回归。原生 UI 自动读取超时，最终 Dock 图标仍待用户实测；不能将此前 accessory 状态验证当作图标验证。冷启动最初瞬间仍由 Electron 开发宿主决定。

此前仅移除搜索 accelerator 的处理已由菜单期间的统一快捷键交接取代。主窗口快捷键的最小交接方案经用户实测反馈正常；后续增加的隐藏项通路有自动测试与 Electron 原生属性支持，但未取得独立的真实交互验证，不能将主窗口验证扩写为全部场景通过。

2026-09-28 验收时产品只有设置一个普通窗口。多窗口轮换算法有自动测试，但没有独立的真实多窗口 Dock 事件时序证据；用户总体验收确认不补充这一证据。后续新增普通窗口时需复验外部首次激活、连续 Dock 点击和最小化恢复，必要时再评估原生 reopen 接入。AX 权限退化、跨 Space／多显示器等场景未提供逐项实测记录，不将总体确认扩写成逐项测量结果。

模块索引与说明留在 crates 下的 README，窗口职责留在 main README，行为与取舍由本 record 承载。本事项未向 `docs/workspace.md` 追加模块或窗口细节；已同步 develop 中独立完成的文档职责规则调整。

### Quick Chat 失焦保留与 Dock 接入（2026-10-25）

按独立交接实现 Quick Chat 失焦保持显示，并由 Launcher owner 按当前模式与实际显隐登记／移出已有普通窗口追踪器。主动收起、设置窗口与原生更新窗口并存、焦点保护及 Dock hide 重试继续沿用既有机制；当前交互维护在 [Quick Chat](../../../desktop/docs/quick-chat.md#产品入口与窗口交互)。

用户补充要求按模式切换窗口层级：搜索／剪贴板置顶，进入 Quick Chat 取消置顶，切回恢复。窗口 owner 的同一模式变更入口覆盖宿主快捷键和 renderer 请求，首次创建也依据当前模式设置层级。

切回搜索的首次修正只保护仍持有 key focus 的 blur，未解决用户的实际故障。12:23:23.060 切回 search，12:23:24.070 blur 同时记录 focused=false、applicationActive=false、dockVisible=false，确认约一秒后的 Dock hide 重试引发真实应用失活。

核对 Electron 44.3.0 的 `Browser::DockHide()`：实际隐藏通过 `TransformProcessType` 转成 accessory 应用，不能把此过程引发的失活当作用户切走。当前改为由 Launcher 同步可见搜索／剪贴板弹层状态，在普通窗口管理器中延后 Dock hide，等弹层收起后才执行。弹层不进入普通窗口列表，也不主动显示 Dock；因此保留输入焦点且不需要抢回外部应用焦点。此策略覆盖异步 show 完成与一秒 hide 重试。产品交互与窗口职责分别更新在包内 Quick Chat 文档和 main README。

自动验证：51 项窗口／焦点／快捷键／设置／启动测试通过，覆盖双入口模式切换、Dock hide 导致窗口和应用真实失焦、主动收起、一秒重试取消、异步 show 与设置／原生窗口并存。新增故障回归在修正前失败。此前 39 项 Launcher／Agent 客户端测试通过，覆盖隐藏观察不停止 Run。`just check`、desktop build 和 diff 空白检查通过。收尾移除 applicationActive、dockVisible 临时诊断字段，保留窗口模式、实际焦点、保留结果与 Dock hide 延后等安全 debug 日志。

运行验证：12:28:12 经现有 cmux console 重建并加载到 oracle，新 Electron 的 cwd／父子关系、构建产物中的延后分支和启动日志已核对。用户复验反馈「看起来正常了」，随后认可 Dock 延后隐藏的取舍并明确要求收尾合并，本切片据此完成，删除独立 Plan。原生自动化连接隐藏窗口仍超时；用户确认不扩写为 Dock／⌘Tab、剪贴板及设置／Sparkle 并存的逐项实测证据，这些边界保留为证据限制。本次未验证 Bash 沙箱的剩余产品场景。record 保留 active，未执行归档。

### 跨 Space 唤起顺序修复

2026-10-18 用户反馈运行一段时间后，从普通桌面按快捷键会切到第三个桌面，窗口随后自行消失。当前工作区实例的原生状态读取确认 Launcher 的 `collectionBehavior` 在复现前后均为 5，仍包含 `CanJoinAllSpaces`，应用 activation policy 为 accessory；只读监测捕捉到主屏从 Space 4 切到 Space 5，窗口短暂显示后隐藏。Electron 44.3.0 的普通窗口 `Show()` 先激活应用，再把窗口置前；改为 macOS `showInactive()` 后 `focus()`，保留既有定位、跨桌面配置和失焦隐藏规则。

新增状态回归模拟应用仍关联第三个桌面、从其他桌面反复唤起；旧实现失败，调整顺序后通过。30 项 Launcher／快捷键／焦点／Dock／Tray 定向回归与 `just check` 通过。通过 cmux 重启已确认归属的 prometheus 开发实例，新 Electron 的 cwd／父子关系正确，15:34:07 启动及原生模块、剪贴板监听、搜索初始化日志正常；构建产物包含新的显示顺序。用户按“先在第三个桌面唤起并收起，再回其他普通桌面连续唤起／收起”的步骤实测，明确确认“不跳转也不消失”。本次验证覆盖该普通桌面复现场景，不扩写为全屏 Space 或全部多显示器场景通过。
