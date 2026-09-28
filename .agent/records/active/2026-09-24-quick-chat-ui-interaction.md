# Quick Chat 入口与内存对话

## Why

用户要求迁移旧版 Quick Chat 时优先核对 Launcher 入口：空搜索框按 ↓ 展开，聊天输入按 Esc 或空内容时按 ↑ 收起并返回搜索框。旧版交互已比较成熟，迁移应先在 Storybook 对齐动画、焦点、菜单优先级和空会话状态。

## What

首片交付 Storybook 中可独立操作的 Quick Chat 入口交互预览：搜索与对话切换、标题栏、模拟会话操作，以及第一次使用或全部会话归档／删除后的空态。其中旧版富文本编辑器、完整消息组件和持久会话仍另行处理；后续最小内存对话接线见下文。用户明确移除“在外部对话窗口打开”按钮。

完成标准是预览可覆盖上述状态与键盘路径，自动检查通过，并由用户确认视觉效果后才能将共享组件接入产品。2026-09-25 用户确认既有交互无问题，并明确要求直接接入 App 后由用户测试。

## How

旧版基线为 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next`，核对时 HEAD `a45f5cd1ba197c76ae6b528d30f382f7080a5100`。入口取自 `xiaowei/src/pages/launcher/LauncherPage.tsx` 与 `modes.tsx`，标题栏取自 `QuickChatTitleBar.tsx`，窗口与输入布局参考 `QuickChatComposer.tsx`。对照的是源码行为，尚未完成旧版运行画面的逐像素核对。

- 空搜索输入（包括纯空格）按 ↓ 展开；非空输入的 ↑↓ 仍导航搜索结果。Quick Chat 中 Esc 收起；仅在编辑目标内且输入 `trim()` 为空时，↑ 收起。非编辑区域的 ↑、有内容时的 ↑ 不收起。
- 从搜索进入对话后，Esc 回搜索；搜索态再次 Esc 才模拟隐藏。Modal、标题栏菜单、重命名和模型菜单先处理自己的 Esc；输入法合成和 keyCode 229 不触发模式切换。
- 视口从 71px 展至 580px，滑轨同步采用 300ms ease-out，收起时保留聊天内容直到过渡结束，再换回搜索框并恢复焦点。反向切换清理旧计时器；输入区增高时消息区等量缩小，过渡中锁定消息滚动。
- 预览位于 `desktop/src/renderer/src/components/quick-chat/`。`QuickChatTransition` 控制视口与滑轨，`QuickChatTitleBar` 接收纯 props／回调，`QuickChatLauncherPreview` 只由 Storybook 和测试使用。搜索框通过 `LauncherSearchBar` 的 `embedded` 属性复用内容；产品默认结构不变。
- 内存 mock 覆盖新建、切换、首发建会话、发送、延迟回复、停止、改名、更新标题、归档和删除。最后一条移除后回到“新的对话／输入问题开始对话”空态。输入暂用 textarea，消息暂用文本布局，模型列表为固定数据。

Storybook 分组为 `Quick Chat / Launcher`，场景包含 Search、FirstUse、ExistingConversations、LastConversation、AllArchived、AllDeleted、SearchResults、SessionMenu、More、Rename、DeleteConfirmation。产品与 Storybook 的 UI 对齐约定见 [Renderer UI 开发](../../../desktop/src/renderer/README.md)。

### 最小内存对话（2026-09-25）

产品 Launcher 已接入 QuickChatPanel；标题栏最小模式仅显示当前首条消息标题与新对话操作，不接会话列表、自动标题、归档或工具能力。消息和草稿由 Launcher 持有的 useQuickChat hook 保存在 renderer 内存；收起、隐藏、切换剪贴板不删除消息，窗口销毁／刷新／退出后丢失。不使用文件、数据库或浏览器持久化存储。

前端通过 services.ts 的 Llm stream typed client 调用 Generate；不引入 Rust agent 或后端会话状态。ModelSettings 先订阅 ready 后 Get，处理迟到结果与 revision；每轮捕获当前使用的 modelRef／thinkingLevel。不提供模型／思考强度选择控件；默认模型未设置或已被删除时，仅在调用处按提供商与模型列表顺序取第一个可用模型，跳过有 unavailableReason 的提供商，不写回默认模型设置，也不沿用原默认模型的思考强度。没有可用模型、显式选中的默认模型凭据不可用或配置应用故障时禁止发送；设置变更只影响后续请求，不影响在途快照。

chat-messages.ts 按块索引累计文本与 thinking，以成功终态中的完整 AssistantMessage 作为回放历史，保留签名、协议元数据与用量。取消或失败的部分回复仅用于显示，不当作成功 assistant 回放；用户消息保留。未收到终态即断流视为失败。请求不声明工具，意外工具输出报错并结束，不执行工具或继续循环。停止、清空及卸载会通过 AbortSignal 取消开流或在途流，旧请求不得覆盖新对话。

LauncherMode.QUICK_CHAT 仅表示原生窗口展示模式。宿主固定聊天高度 580px；从剪贴板切入时直接挂载展开的聊天面板，不重放搜索展开动画；从搜索展开先完成原生扩高再显示动画，收起后等待 300ms 再恢复搜索高度，聊天中搜索结果不缩小窗口。Cmd+Space 在所有模式下仅切换窗口显隐，重新显示时聚焦当前输入；Cmd+Shift+C 按剪贴板入口的同模式显隐／跨模式切换规则唤起快速对话，剪贴板切换保留内存对话。快速对话展开和窗口重新聚焦时聚焦 composer。LauncherOpened 订阅在页面存活期间保持连接，通过 React effect event 读取最新 UI 状态；不得因剪贴板模式变化重建订阅，避免解绑／重绑空档丢失快捷键通知。输入使用纯文本 textarea，Enter 发送、Shift+Enter 换行，输入法合成不发送；Esc／空输入 ↑ 收起，新对话清空并停止在途生成。标题栏提供 Electron 拖动区域。

2026-09-28 用户确认居中空态和设置跳转效果后接入产品。没有可用模型时，消息区以灰色图标和普通文字展示“暂无可用模型”，已有消息保留并在其后显示配置引导；不再以红色错误展示缺少模型。“设置 - 模型”调用 System.OpenSettings(anchor: SettingsAnchor.MODEL_PROVIDERS)，窗口控制器复用／创建设置窗口并隐藏 Launcher。System owner 按实际 BrowserWindow 定向交付空通知 SettingsNavigationRequested；保留最后一个待处理目标，事件仅通知页面读取，订阅和发送通知都不清空目标。有效 SettingsPage 在订阅 ready 后及收到通知时调用 System.TakeSettingsNavigation 原子读取并清除目标，返回 TakeSettingsNavigationResponse.anchor；已清理的 effect 不发起读取，避免 StrictMode 首次订阅清理时提前消费。不写入持久化设置。SettingsPage 切到模型页，ModelSettingsPage 等模型快照加载完成后滚动到模型提供商配置区域（含添加按钮），以主色描边高亮 1.6 秒；重复导航重新计时，手动切页清除本次导航。打开设置失败时在引导下显示错误，可再次点击重试。

新增 Quick Chat / Chat 的 9 个 Storybook 场景仅使用模拟流；产品不导入预览适配器。旧完整标题栏和入口预览继续保留。本片是用户要求的简化实现，不宣称与旧版后端会话、工具循环、富文本消息或持久化全面等价。

## Current work

2026-09-28 用户已确认空态和设置跳转视觉效果，产品接入、自动验证和当前工作区重启完成；用户反馈首次跳转停留通用页，已复现 StrictMode 订阅清理导致目标丢失，改为显式消费；修复后的 Electron 跳转仍待验证。未为验收修改用户模型配置或发送模型请求。

2026-09-26 用户反馈移除日志后再次卡顿。顺畅期间日志的主进程回调中位数约 4ms、React 提交中位数约 1.9ms，不足以确认卡顿根因。此前同模式通知没有触发提交时，计时引用会一直保留到其他更新，因此出现的 611ms 样本不能当作一次模式切换耗时。

flushSync 同步提交尝试通过了回调结束时 DOM 已更新的检查，但用户确认仍卡顿，因此已撤回该改动和仅用于验证同步提交的测试；不能将普通 React 更新排队当作已确认根因。

延后采样版本再次变顺畅，随后核对到主进程原生热键回调与 Gateway 微任务投递之间缺少确定的 Node 调度边界。现由 Gateway Node 事件队列通过 setImmediate 启动投递，快捷键直接执行业务 action，全部采样、前端开关和 flushSync 已删除；用户已通过实际按键确认卡顿修复；详细源码依据与验证结果见 [快捷键事项](2026-09-18-fixed-launcher-shortcuts.md#原生快捷键与微任务调度)。renderer 保留稳定订阅和剪贴板切聊天直接展开行为。

## Outcome

2026-09-28 根据“暂无可用模型”的引导语义，将锚点改为模型提供商配置区域，包含添加入口，不再定位默认模型行。契约统一为 SettingsAnchor.MODEL_PROVIDERS 与 anchor 字段，SettingsNavigationRequested 仅作空通知，TakeSettingsNavigationResponse 返回待消费锚点；同步产品、Storybook 与测试。回归验证高亮区域包含“模型提供商”且不包含“默认模型”，并保留 StrictMode 与重复跳转覆盖。完整桌面测试、契约 codec、just check 通过；已确认当前工作区实例并执行 just rs。

2026-09-28 修复首次设置导航停留通用页：StrictMode 的首次 effect 清理会取消订阅，旧实现却在 attach 时提前删除待跳转目标，第二次订阅没有目标可取。main 回归通过“订阅后立即关闭，再次订阅”在修复前得到空事件列表而失败。改为保留待处理目标，由有效页面通过 TakeSettingsNavigation 原子读取并清除；事件只通知读取。保持 StrictMode，页面回归覆盖 StrictMode 首次挂载、延迟加载与重复跳转，完整桌面测试、契约 codec 和 just check 通过；当前工作区已通过 just rs 重启，09:41:29 renderer 与原生服务启动正常，实际点击待用户复验。

2026-09-28 接入居中模型空态与“设置 - 模型”导航。新增 System.OpenSettings 与定向 SettingsNavigated，覆盖先打开后订阅、已打开窗口重复导航、无效目标与打开失败；产品测试覆盖点击链接、延迟加载后定位以及高亮重触发。`just check`、完整 `pnpm --dir desktop test`（含 97 项 renderer 测试）、契约 codec 与生成一致性检查通过，受影响的 storage／search／clipboard napi 正式产物已重建。并行构建中的 Vite／napi 临时文件曾使 Biome 扫描失败，构建结束后重新运行完整检查通过，未修改无关规则。通过 Electron／nodemon 命令、cwd 与父子进程确认实例属于当前工作区后执行 `just rs`；09:37:08 新实例启动，原生模块、LLM worker、renderer 和搜索索引初始化正常。

2026-09-28 按用户澄清实现调用处的临时模型选择：无默认模型／默认模型已删除且仍有可用模型时可以直接对话，不修改持久化默认值。覆盖空默认值、删除后重新选择、跳过不可用提供商、没有可用模型时阻止调用与不修改设置；hook／面板／Launcher 共 18 项测试通过，类型检查和 Biome 通过。视觉预览拆分为 No Models（配置提示）与 Missing Default（正常空对话，可模拟发送），空态／设置跳转随后经用户确认接入，见上述当前行为。

2026-09-26 修复模式通知订阅竞态：旧订阅 effect 依赖 clipboardOpen，进入／离开剪贴板会重建订阅，期间可能丢失 Quick Chat 通知，导致主进程已切换但页面仍留在剪贴板。回归通过延迟重复订阅稳定复现界面未切换；改为稳定订阅和 useEffectEvent 后，21 项 Launcher／QuickChatPanel／QuickChatTransition 测试、类型检查、Biome 通过。当前工作区已热更新；自动桌面按键未触发系统全局快捷键，未以该尝试作为平台验收通过。用户随后确认加日志并重启后已不再卡顿，并要求移除临时调试代码；订阅修复与回归测试保留，未采到卡顿现场，性能根因未确认。

2026-09-26 修复剪贴板切入 Quick Chat 时重放搜索展开动画：两者同为 580px 面板，切换时直接以展开状态挂载聊天。新增回归先复现多余动画，再验证直接展开、输入焦点及后续搜索展开／收起动画保留；20 项 Launcher／QuickChatPanel／QuickChatTransition 测试、类型检查和 Biome 通过。

2026-09-25 合并前 review 发现并修复两项问题：有效配置事件不能恢复初始读取错误、长对话收起后再展开丢失滚动位置。新增回归先复现 3 个失败场景，再验证修复；hook／面板／Launcher 合计 13 项通过。按用户反馈移除出字后的“正在生成”提示，保留等待首字、思考内容和停止按钮。无剩余 review 问题。

2026-09-25 最小内存对话已接入产品。完整 desktop 测试通过：27 项模块测试、7 项 main 测试、51 项 LLM 测试、87 项组件／页面测试、4 项 Rust typed 集成与 6 项业务集成；新增用例覆盖默认配置、多轮完整回放、开流取消、清空／卸载、迟到回复、断流、工具拒绝、窗口布局和模式切换。契约 codec、生成检查、Storybook 构建及 just check 通过，三个正式 napi 产物已重建／恢复。确认当前工作区实例后执行 just rs，23:46:21 新进程启动正常；未操作 UI 或发送真实模型请求。用户随后在 App 验证生成并确认能触发思考内容，要求 review 后合并。已完成本片验收，02 Plan 删除；以下首片结果保留为历史。

已实现组合预览和 11 个 Storybook 场景，去掉外部对话窗口打开按钮。24 项相关测试、desktop 类型检查、Biome 和 Storybook 构建通过。Chrome 中采样到展开 71px → 约 355px → 580px、收起 580px → 约 297px → 71px，并验证搜索焦点恢复和明暗状态。

当前仅为 Storybook 预览；尚未接真实 Launcher、模型、会话或用户数据，也未启动 Electron。用户视觉确认、旧版运行画面对照、原生窗口动画和真实输入法验收仍待完成。
