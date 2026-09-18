# UI 对齐与 Storybook

Storybook 是组件开发和验收入口，与 Electron 共用真实组件及全局样式。启动 `just storybook` 后访问 http://127.0.0.1:6006；它只启动网页服务，不启动桌面应用。静态构建使用 `pnpm --dir desktop storybook:build`，输出 `desktop/storybook-static/`，不提交产物。

## 每个功能的迁移流程

1. 在已有迁移 record 或对应说明文档中记录旧版源码位置、尺寸和交互，并建立状态清单，不为此强制新建 record；区分原样迁移、明确调整和暂缓。旧版实际表现是初始基准，源码样式参数辅助对齐。
2. 提取纯 React 组件，用 props 接收数据、用回调通知外层。Electron IPC、Rust 调用和网络请求留在页面适配层。组件与 `.stories.tsx` 放在一起。
3. 用固定模拟数据建立空内容、有内容、长文本、明暗主题及相关错误/加载场景。没有真实需求时不创建无意义的状态。
4. 在 Storybook 中对照旧版截图，固定视口、主题和字体环境。通过 `play` 检查组件键盘等交互。需要人工检查的输入法和平台行为明确记录，不用普通键盘模拟冒充输入法验收。
5. 接入真实业务，在 Electron 或 RN 中验收平台行为。确认过的视觉结果才可成为新基线；当前未配置自动截图回归服务，不把构建通过视为视觉验收通过。

后续 RN 可复用设计规范、场景定义及模拟数据，原生组件与 Storybook 运行环境独立；不强行复用 DOM 组件。Rust 业务逻辑的复用与集成在接入具体业务时讨论。

## 首个样例：Launcher / SearchBar

入口组件是 `desktop/src/renderer/src/components/LauncherSearchBar.tsx`，场景文件与其相邻。

- `Empty`：空输入，可直接输入文字。
- `With Query`：已有搜索内容，聚焦全选。
- `Long Query`：长文本不挤压右侧 Logo。
- `Dark`：固定深色主题；其余场景可通过工具栏切换主题。
- `Composing Escape`：合成组合输入事件，验证此时 Esc 不触发关闭或清空；不能替代真机输入法验收。
- `Refocus Selects Query`：模拟窗口重新聚焦，验证输入框聚焦并全选当前文字。
- `Escape Dismisses`：自动输入 Esc，断言文本被清空且关闭回调触发一次。这里只检查回调，浏览器场景不会隐藏 Electron。

旧版参照：`xiaowei-next` 中的 `LauncherSearchBar.tsx`、`LauncherPage.tsx`、`app.css` 和 `window/config.rs`。窗口 800 × 71，外层左右 4px / 上下 2px，卡片 12px 圆角，搜索栏原版左右 24px / 上下 16px；当前按用户调整为左 24px、右 16px，文字 16px，Logo 32px。沿用旧版明暗配色；Logo 使用本项目指定图片的透明版 `desktop/resources/logo-clear.png`，明暗主题共用。提示仅保留“输入搜索内容”，未接入快速对话前不提示 ↓ 快速对话。

本轮只迁移搜索入口，不模拟搜索结果或内部服务。全局快捷键、失焦隐藏、拖动、屏幕定位及输入法需在桌面单独验收。启动桌面仍由用户执行，Agent 仅在确认当前工作区有运行实例时使用 `just rs`。

本机默认文件事件监听曾返回旧组件缓存，Storybook 的 Vite 预览使用 100ms 轮询监听以保证热更新。Logo 已改为透明版，不再添加边框。

当前搜索框视觉样式已于 2026-09-16 获用户确认：透明 Logo、右内边距 16px，其余基础布局按旧版参数。该确认作为后续变更评审的起点；不代表尚未迁移的结果列表和原生窗口行为已通过验收。

当前独立搜索框不显示结果列表分隔线，输入行填满卡片高度并垂直居中，避免底部留下额外横线。后续接入结果列表时再由容器决定是否显示分隔线。

## 主题色

品牌主色沿用旧版绿色 `#00C572`，统一定义为 `--color-primary`，不要求与 Logo 像素颜色完全一致。Logo 当前保持不变。

搜索命中等普通字号的绿色文字使用 `--color-primary-text`：浅色主题为同色系深绿 `#007A46`，深色主题使用品牌主色，以兼顾背景与选中行上的可读性。组件使用语义颜色类 `text-primary-text`，不直接写 Tailwind 蓝色或独立色值。桌面和 Storybook 共用此定义。

## Launcher / SearchResults

结果列表与桌面共用 `SearchResultList`，场景包括 Mixed、Dark、Scroll、SelectAndConfirm；`Launcher / Interaction / KeyboardAndComposition` 使用真实 Launcher 组件和模拟 IPC，覆盖方向键边界、回车确认及合成输入法事件。后者不替代原生输入法验收。

旧版结果列表参数已迁入：48px 行高、4px 行间距、14px 标题、22px 图标、应用图标 1.25 倍留白补偿、主题色选中背景（浅色 `#D4F7E6`、深色 `#152B2A`）、8px 键盘滚动余量。新版绿色高亮使用上文的语义变量。真实应用图标仍由 Electron 获取，与旧 NSWorkspace 提取结果需在真机对照。

## Clipboard / Panel

`ClipboardPanel` 由桌面与 Storybook 共用，按旧版 launcher 模式标签、收藏／剪贴板／图片／文件导航、列表和底部工具栏布局迁移。尺寸、快捷键、直接复用的旧版组件及未迁移能力以 [剪贴板 record](../.agent/records/active/2026-09-17-migrate-local-clipboard.md) 为准，不自行设计替代交互。尚未获得用户视觉验收。

Storybook `Clipboard / Panel` 包含 History、Dark、Empty、Favorites、LongText、Image、Files、Loading、LoadError、NoMatches、Json。`KeyboardAndActions` 检查选中、回车使用、收藏、删除确认和 Esc 返回；`CategoriesAndContextMenu` 检查左右键分类循环、右键复制、详情折叠、取消删除和空输入 Backspace 返回。`Launcher / Interaction / OpenClipboard` 检查从搜索结果进入面板、尺寸切换及返回。`EditingAndCategories` 检查文本编辑、备注保存、归类、分类创建与改名、删除分类确认。所有弹窗复用从旧版迁入的本地 `Modal` 组件，不依赖 `@tencent` 私有 UI 包。浏览器模拟 IPC 不替代 Electron 真机验收。

`ResourceMenus` 检查文件卡片操作、图片复制路径子菜单、定位和长文本查看入口；`MarkdownWebContent` 检查 Web 链接回调和远程图片元素，浏览器验收使用固定图片响应。外部应用打开和 Finder 定位仍须真机验收。
