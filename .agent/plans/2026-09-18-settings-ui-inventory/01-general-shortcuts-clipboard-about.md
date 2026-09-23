# 第一部分：通用、快捷键、剪贴板、关于

## 范围与前置

- 本切片建立设置窗口和可供第二部分复用的 setting 模块，并接入通用、快捷键、剪贴板、关于四页。模型、智能体、归档的业务接入在第二部分；旧版数据及附件的离线一次性迁移仍按剪贴板事项单独实施，设置页不提供迁移入口。账号登录／云连接、快速对话、图片内容提取、自动更新和“检查更新”操作按用户 2026-09-23 的要求暂缓，不属于两部分计划的完成条件。相关 Storybook UI 保留，产品本期跳过这些入口。
- 接入任何真实页面前，按 `docs/ui-alignment.md` 取得本切片 Storybook UI 的用户确认；`Settings/Window/PhaseOneScope` 已于 2026-09-23 获用户确认。逐项核对旧版源码和当前产品能力；已明确暂缓的账号／云连接、快速对话、图片提取和自动更新仅留在 Storybook，产品适配层不渲染对应入口。其他可操作项必须有真实领域能力，不使用预览数据或空操作完成验收。
- 保持现有 `SettingsPreview.tsx` 仅作 Storybook 内存适配；产品接入复用 `GeneralSettings`、`ShortcutSettings`、`ClipboardSettings`、`AboutSettings` 和 `SettingsLayout`，另建产品容器，不复制组件。真正的 macOS 标题栏按钮由原生窗口提供，不渲染预览中的装饰按钮。

## 实施顺序

1. **设置模块和窗口。** 核对旧版 `xiaowei/src/api/settings.ts`、`stores/settingsStore.ts` 的键、默认值和变更时序。由 `crates/xiaowei-storage/src/settings/` 定义默认值、范围校验与旧 `setting.*` 键映射，在 `xiaowei-storage` 的 Rust 数据库上逐项保存；`Settings` Gateway 提供有类型的快照、单项更新和已提交变更事件。主进程只通过 Gateway 获取设置，并为开机启动、剪贴板监听和快捷键注册提供系统操作回调；失败时恢复此前状态。底层 `meta` 表不作为公开服务，通用 JSON KV 使用 `KeyValue` 契约。`SettingsPage.tsx` 负责初次加载、订阅、失败回滚和窗口间同步，不能把 KV 原始 JSON 当作有效设置。`desktop/src/main/index.ts` 创建独立 800 × 600 设置窗口及可发现的打开入口，`desktop/src/renderer/src/main.tsx` 路由到产品容器。验证关闭再打开、重启后读取、无效值和并发修改，保留 Launcher 原来的窗口行为。
2. **通用。** 在产品适配层接入主题（跟随系统时响应 OS 主题变化）、开机自启动和 Chrome 书签开关；主进程处理 `app.setLoginItemSettings` 类系统操作，失败不得显示为保存成功。搜索目前由 `crates/xiaowei-search/src/lib.rs` 直接收集 Chrome 书签；让设置真正控制查询结果，并在更改后刷新，不只隐藏 UI 命中。账号登录／云连接暂缓；产品不渲染账号区，Storybook 保留其模拟状态。
3. **快捷键。** 用 `ShortcutSettings.tsx` 的去重语义建立注册前校验；将 `desktop/src/main/index.ts` 启动时硬编码的搜索／剪贴板快捷键改为从 setting 加载，由 `desktop/src/main/settings-shortcuts.ts` 转换快捷键并在修改后原子地注销／注册、检查冲突，失败恢复旧注册和旧值。录制值与 Electron accelerator 的转换要覆盖 macOS 和非 macOS，重新启动后仍生效。快速对话目前无对应 Launcher 模式或窗口，暂缓；产品不显示该行，也不注册或保存无动作快捷键，完整 Storybook 预览继续保留。
4. **剪贴板。** 将启用监听、保留期限和自动粘贴连接到剪贴板生命周期和产品选取动作。选择动作经 `ClipboardBiz.Select` 调用真实复制，隐藏 Launcher 并交还前台应用焦点，再按设置和 macOS 辅助功能权限发送 Command‑V；右键复制继续只调用 `ClipboardBiz.Copy`。在 `desktop/src/main/clipboard-storage.ts` 新增已用空间查询及刷新，包含数据库和附件；关闭或重新打开设置窗口后仍能显示真实数据。“清理全部”使用点击时刻作为截止时间，只删除未收藏、无备注、无分类／标签等保护信息的普通数据；按旧版自动清理规则复用附件释放和事件通知，不能调用现有只排除收藏的 `ClearHistory`。为设置动作设计明确的 Clipboard 业务方法并更新生成契约；Rust 修改后构建 clipboard napi。图片内容提取暂缓；产品不渲染其开关与跳转，Storybook 保留模拟状态，后续单独决定实现范围。离线迁移不暴露给用户。
5. **关于与产品验收。** 版本、开发态来自 Electron；本期产品“关于”页不提供“检查更新”入口，也不接入更新服务。Storybook 保留模拟检查更新按钮；产品适配层不渲染该入口，其余关于页 UI 在接入前取得用户确认。设置窗口使用原生标题栏；确认操作系统按钮不与预览装饰按钮重复。逐页核对导航、保存失败、窗口重开和主题／快捷键／搜索／剪贴板业务效果，完成后再更新本事项 `How`／`Outcome` 并删除本 Plan。

## 验证

2026-09-23 进展：`Settings/Window/PhaseOneScope` 已获用户确认，产品四页适配层、独立窗口、原生菜单入口及 `ClipboardBiz.Select` 调用已接入；桌面类型检查、单测、构建和 Storybook 构建通过。用户已启动当前工作区 Electron；核对实例归属后执行 `just rs`，确认新进程启动。快捷键键帽的 Cmd／Shift 字形调整已获用户确认，真实窗口使用同一组件；原生菜单可打开设置，AX 树确认四页导航及原生窗口按钮。仍待验收窗口重开、系统快捷键、Chrome 书签开关、剪贴板粘贴和登录项；完成并回填结果后删除本 Plan。

- 为设置定义与 Gateway 方法测试默认值、坏数据、写入失败、通知、重启读取和多窗口同步；为快捷键冲突及回滚、书签过滤、清理保护条件和附件释放写业务测试；验证选取、仅复制、关闭自动粘贴和拒绝无效条目四种路径。保留现有 Settings Storybook 和独立交互测试，产品容器另测真实服务调用，不用模拟返回代替业务验收。
- 涉及 proto 先生成并运行 `pnpm contracts:check`；涉及 Rust 按仓库规则构建受影响的 napi。运行 `pnpm --dir desktop check`、`pnpm --dir desktop test`、`pnpm --dir desktop storybook:build`、`just check` 及相应 Rust 测试。确认属于当前工作区的运行实例后才可 `just rs`；否则请用户启动并完成原生窗口、系统快捷键、实际剪贴板的人工验收。开机自启动还须在已签名并正确安装的 macOS 包中验证读取与写入，开发包的成功回调不能证明登录项已生效。
- 完成标准：四页呈现真实状态；可操作项确实改变对应行为，错误不产生虚假的成功反馈；没有未确认 UI 混入产品，旧版迁移入口与“检查更新”入口不可见。自动粘贴能力尚未建成时，不把本切片标为全部完成；快速对话、账号／云连接、图片提取及自动更新不阻塞本切片。
