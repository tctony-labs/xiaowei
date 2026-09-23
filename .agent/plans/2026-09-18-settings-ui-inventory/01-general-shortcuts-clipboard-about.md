# 第一部分：通用、快捷键、剪贴板、关于

## 范围与前置

- 本切片建立设置窗口和可供第二部分复用的 setting 模块，并接入通用、快捷键、剪贴板、关于四页。模型、智能体、归档的业务接入在第二部分；旧版数据及附件的离线一次性迁移仍按剪贴板事项单独实施，设置页不提供迁移入口。账号登录／云连接、图片内容提取、自动更新和“检查更新”操作按用户 2026-09-23 的要求暂缓，不属于两部分计划的完成条件。相关 Storybook UI 保留，产品本期跳过这些入口。
- 接入任何真实页面前，按 `docs/ui-alignment.md` 取得本切片 Storybook UI 的用户确认。当前产品只有 Launcher 窗口；快速对话和自动粘贴服务并不完整。逐项核对旧版源码和当前产品能力；已明确暂缓的账号／云连接、图片提取和自动更新仅留在 Storybook，产品适配层不渲染对应入口。其他可操作项必须有真实领域能力，不使用预览数据或空操作完成验收。
- 保持现有 `SettingsPreview.tsx` 仅作 Storybook 内存适配；产品接入复用 `GeneralSettings`、`ShortcutSettings`、`ClipboardSettings`、`AboutSettings` 和 `SettingsLayout`，另建产品容器，不复制组件。真正的 macOS 标题栏按钮由原生窗口提供，不渲染预览中的装饰按钮。

## 实施顺序

1. **设置模块和窗口。** 核对旧版 `xiaowei/src/api/settings.ts`、`stores/settingsStore.ts` 的键、默认值和变更时序，以及现有 `contracts/proto/xiaowei/meta.proto` 的缺失值语义。先在 `desktop/src/shared/settings/` 定义类型、默认值、范围校验和 `setting.` 键映射；在 `desktop/src/main/settings.ts` 以已装配的 Meta client 保存已验证值，并在成功后发出变更通知。按 `contracts/proto/xiaowei/README.md` 增加当下必需的 Settings 业务方法及事件，生成契约，更新 `desktop/src/main/gateway.ts`、`desktop/src/renderer/src/services.ts`；新建 `desktop/src/renderer/src/components/settings/SettingsPage.tsx` 作为产品容器，配合 renderer 设置状态模块负责初次加载、订阅、失败回滚和窗口间同步，不能把 Meta 的原始 JSON 当作有效设置。`desktop/src/main/index.ts` 创建独立 800 × 600 设置窗口及可发现的打开入口，`desktop/src/renderer/src/main.tsx` 路由到产品容器。验证关闭再打开、重启后读取、无效值和并发修改，保留 Launcher 原来的窗口行为。
2. **通用。** 在产品适配层接入主题（跟随系统时响应 OS 主题变化）、开机自启动和 Chrome 书签开关；主进程处理 `app.setLoginItemSettings` 类系统操作，失败不得显示为保存成功。搜索目前由 `crates/xiaowei-search/src/lib.rs` 直接收集 Chrome 书签；让设置真正控制查询结果，并在更改后刷新，不只隐藏 UI 命中。账号登录／云连接暂缓；产品不渲染账号区，Storybook 保留其模拟状态。
3. **快捷键。** 用 `ShortcutSettings.tsx` 的去重语义建立注册前校验；将 `desktop/src/main/index.ts` 启动时硬编码的搜索／剪贴板快捷键改为从 setting 加载，并在修改后由主进程原子地注销／注册、检查冲突，失败恢复旧注册和旧值。录制值与 Electron accelerator 的转换要覆盖 macOS 和非 macOS，重新启动后仍生效。快速对话目前无对应 Launcher 模式或窗口：先实现其目标行为再注册，不把一个没有动作的快捷键保存为可用。
4. **剪贴板。** 将启用监听、保留期限和自动粘贴连接到 `crates/xiaowei-clipboard/src/` 的实际生命周期和产品选取动作。新增已用空间查询及刷新，包含数据库和附件；关闭或重新打开设置窗口后仍能显示真实数据。“清理全部”使用点击时刻作为截止时间，只删除未收藏、无备注、无分类／标签等保护信息的普通数据；按旧版自动清理规则复用附件释放和事件通知，不能调用现有只排除收藏的 `ClearHistory`。为设置动作设计明确的 Clipboard 业务方法并更新生成契约；Rust 修改后构建 clipboard napi。图片内容提取暂缓；产品不渲染其开关与跳转，Storybook 保留模拟状态，后续单独决定实现范围。离线迁移不暴露给用户。
5. **关于与产品验收。** 版本、开发态来自 Electron；本期产品“关于”页不提供“检查更新”入口，也不接入更新服务。Storybook 保留模拟检查更新按钮；产品适配层不渲染该入口，其余关于页 UI 在接入前取得用户确认。设置窗口使用原生标题栏；确认操作系统按钮不与预览装饰按钮重复。逐页核对导航、保存失败、窗口重开和主题／快捷键／搜索／剪贴板业务效果，完成后再更新本事项 `How`／`Outcome` 并删除本 Plan。

## 验证

- 为设置定义与 Gateway 方法测试默认值、坏数据、写入失败、通知、重启读取和多窗口同步；为快捷键冲突及回滚、书签过滤、清理保护条件和附件释放写业务测试。保留现有 Settings Storybook 和独立交互测试，产品容器另测真实服务调用，不用模拟返回代替业务验收。
- 涉及 proto 先生成并运行 `pnpm contracts:check`；涉及 Rust 按仓库规则构建受影响的 napi。运行 `pnpm --dir desktop check`、`pnpm --dir desktop test`、`pnpm --dir desktop storybook:build`、`just check` 及相应 Rust 测试。确认属于当前工作区的运行实例后才可 `just rs`；否则请用户启动并完成原生窗口、系统快捷键、实际剪贴板的人工验收。开机自启动还须在已签名并正确安装的 macOS 包中验证读取与写入，开发包的成功回调不能证明登录项已生效。
- 完成标准：四页呈现真实状态；可操作项确实改变对应行为，错误不产生虚假的成功反馈；没有未确认 UI 混入产品，旧版迁移入口与“检查更新”入口不可见。快速对话或自动粘贴能力尚未建成时，不把本切片标为全部完成，按明确确认的范围调整计划；账号／云连接、图片提取及自动更新不阻塞本切片。
