# 设置窗口 UI 清单与 Storybook 范围

## Why

用户要求先核对旧版设置窗口并列出 UI 清单，随后确认除扩展外均制作 Storybook。当前仅制作设置 UI 预览，不实施设置业务，不依赖 gateway、统一数据库或 setting 服务。

## What

用户已确认制作除扩展外的全部页面及相关弹窗 Storybook；扩展不实施。以下保留完整旧版源码清单供对照。Storybook 复用纯展示组件和模拟数据，逐项确认后才能接入实际页面与业务。

参考仓库：`~/Develop/XiaoWei/workspace/src/xiaowei-next`。入口为 `xiaowei/src/pages/SettingsPage.tsx`，下表源码均相对该仓库的 `xiaowei/src/components/settings/`。

| 编号 | 页面／区域 | 旧版 UI 内容 | Storybook 重点状态与交互 | 源码 |
| --- | --- | --- | --- | --- |
| 0 | 窗口框架 | 左侧 207px 导航、8 个页签、固定页标题、内容区滚动、顶部 32px 拖拽区、初始化加载、设置项定位高亮 | 明暗主题、页签切换、长内容滚动、跳转定位高亮；原生拖拽另行验收 | `SettingsLayout.tsx`、`SettingsTabLayout.tsx`、`SettingsAnchor.tsx` |
| 1 | 通用 | 账号卡片；主题（跟随系统／浅色／深色）；开机自启动；全局搜索包含浏览器书签 | 未登录、等待扫码、登录失败；头像／昵称／UIN 复制／退出；未连接、连接中、已连接、登录失效；开关与主题选择 | `GeneralTab.tsx`、`AccountSection.tsx` |
| 2 | 快捷键 | 全局搜索、快速对话、剪贴板 | 已设置、未设置、录制按键、清除、Esc 取消；重复快捷键转移行为 | `ShortcutTab.tsx`、`ShortcutSettingsCard.tsx`，以及 `../ShortcutInput.tsx` |
| 3 | 剪贴板 | 启用记录、自动粘贴、图片内容提取、保留期限（1／7／15／30 天／永久）、已用空间与刷新、从旧版迁移数据 | 开关；图片提取已启用／跳转模型页；空间计算中；迁移检查／进行中／完成／未找到数据库／失败 | `ClipboardTab.tsx` |
| 4a | 模型：默认选择 | 默认模型、小文本任务模型、默认思考模式、图片生成模型 | 无可用模型、已配置模型；思考强度关闭／较小／中等／较大／极大；图片模型验证中／成功／失败 | `LlmTab.tsx`、`DefaultModelSection.tsx` |
| 4b | 模型：提供商 | 提供商列表与选择；添加／修改／删除；保存后的切换确认 | 预设／自定义、名称、Base URL、Protocol、Responses Transport、API Key、默认模型、上下文窗口与按模型覆盖；保存中、错误、删除确认 | `ApiKeySection.tsx`、`ApiKeyModal.tsx`、`ContextWindowField.tsx` |
| 4c | 模型：本地模型 | 启用开关、当前模型、切换弹窗、磁盘占用、打开模型目录 | 关闭／展开；未下载、下载进度、校验中、解压中、已就绪、失败；模型选择 | `LocalModelSection.tsx`、`BaseModelPickerModal.tsx`、`BaseModelRow.tsx`、`ModelStateBadge.tsx` |
| 5 | 智能体 | 单轮工具调用上限（30／50／100／300）；网络搜索源 Bing／Tavily／Brave／Serper；Key 配置和测试 | 未配置 Key、配置／修改／删除 Key 弹窗、删除确认、测试中／成功／失败、设置项高亮 | `AgentTab.tsx`、`WebSearchSection.tsx`、`WebSearchApiKeyModal.tsx` |
| 6a | 扩展：列表与详情 | 生成／新建／导入入口；列表图标和状态；详情返回、调试、本地发布、目录与解释器、触发配置、环境变量、发布管理、开发者信息 | 加载、空列表、错误、无效／已发布／调试中；详情切换、目录丢失、配置错误、禁用动作 | `ExtensionsTab.tsx` |
| 6b | 扩展：弹窗 | 新建、导入、删除 | Script／UI 类型；Bash／AppleScript／Python／JavaScript；图标选择与生成、名称简介、解释器、开发目录、开发者信息；导入确认；删除时可选同时删除源码 | `ExtensionsTab.tsx` |
| 7 | 对话归档 | 不活跃对话归档期限（1／3／7／15 天）；清理期限（关闭／1／3／6 个月／1 年）；归档列表、标题／工作区搜索、恢复、永久删除 | 加载、空列表、无匹配、列表、恢复操作、永久删除确认 | `ArchiveTab.tsx`、`ArchivedSessionList.tsx`、`ArchivedSessionRow.tsx` |
| 8 | 关于 | Logo、应用名、版本、检查更新（开发态隐藏）、版权 | 版本有／无、开发／正式显示差异、明暗主题 | `AboutTab.tsx` |

## How

每个选定页面先核对旧版样式及交互，按 [UI 对齐与 Storybook](../../../docs/ui-alignment.md) 制作预览。现有公开／本地组件优先复用，不引入旧版私有 `@tencent` UI 依赖。登录、模型下载、联网测试、系统设置和文件操作在预览中仅模拟。

当前预览位于 `desktop/src/renderer/src/components/settings/`：

- `SettingsLayout`、`SettingsTabLayout`、`SettingCard`、`SettingRow` 与选择器、开关、快捷键录制沿用旧版结构。侧栏 207px，标题栏最小 44px，内容左右 24px，卡片圆角 12px，设置行最小 42px。旧版窗口尺寸参考 `xiaowei/studio/src/window/config.rs`，为 800 × 600，可调整大小。
- 七个页面组件接收 props 和回调；`SettingsPreview.tsx` 只供 Storybook 组合展示，提供内存数据、模拟异步返回与错误，不连接 Electron／Rust／网络，不写配置或系统剪贴板。
- 相邻 `*.stories.tsx` 按 Window、General、Shortcuts、Clipboard、Models、Agent、Archive、About 分组。Storybook 可切页，也可直接选择弹窗或状态；明暗沿用当前项目主题变量，背景等设置专用样式放在 `settings.css`。没有更改产品正在使用的共享组件。
- 模型配置保留 deepseek 预设、OpenAI Chat／Responses／Anthropic 协议、Responses 自动／仅 HTTP 传输、默认及逐模型上下文窗口。模型目录、下载和网络校验均为模拟；显示的模型与账号不代表真实配置。
- 关于页采用当前项目 Logo、示例版本，版权通过可选 prop 提供，本次预览不显示旧 Tencent 版权。
- 不提供扩展导航或占位页；不包含“清空未收藏历史”。未创建实际设置窗口，未注册设置入口或改变当前固定快捷键。

需要明确区分的边界：

- “清空未收藏历史”是本次另行记录的新增入口，旧版 `ClipboardTab` 没有；用户预计将其放在设置中，暂不实施，见 [剪贴板后续事项](2026-09-17-migrate-local-clipboard.md)。
- 旧版账号使用微信登录、UIN 和云连接状态，是否保留及如何调整待定。
- 旧版快捷键包含快速对话及自定义录制；当前产品仅有固定搜索／剪贴板快捷键，清单不表示已授权改变产品行为。
- 关于页的旧品牌资源、Tencent 版权及更新机制需在迁移该页时明确调整，不直接照搬。
- 本次只核对源码，没有取得旧版窗口截图；视觉验收仍需逐项完成。

## Current work

已完成除扩展外的页面与弹窗预览及自动检查。用户视觉确认仍待完成；确认前不接入实际窗口或业务，事项保持 active。

本机 6006 已由另一个工作区占用，本工作区 Storybook 使用 `http://127.0.0.1:6007/`，不停止或替换原有服务。浏览器验证使用用户现有 Chrome，经 `agent-browser` CDP 连接。


## Outcome

- 已交付 7 个设置页面、公共框架及模型／搜索 Key／归档弹窗；共 81 个 Storybook 场景，其中 19 个带 `play` 交互检查。
- 在现有 Chrome 的 800 × 600 视口完成全部 81 个场景渲染及 19 个交互检查，没有 `storyThrewException` 或 `playFunctionThrewException`。检查覆盖页签导航、账号和开关、快捷键重复转移与取消、迁移反馈、跳转本地模型、提供商增删改与切换、协议／上下文覆盖、图片模型失败、搜索 Key 删除回退 Bing、归档搜索与删除。
- 人工检查当前预览的通用深色、快捷键浅色、剪贴板浅色、模型深色、智能体深色、归档浅色、关于深色和提供商弹窗截图。旧版运行截图未取得，不宣称已经完成用户视觉对齐验收。
- 输入测试使用 `fireEvent.change`：当前 Storybook 的 `userEvent.type` 会改变 DOM 输入值但未触发 React 受控值更新；真实 Chrome 输入已另行核验。未为了测试添加产品输入逻辑。
- `just check`、`pnpm --dir desktop build`、`pnpm --dir desktop storybook:build` 通过；新增代码显示宽度不超过 120。没有修改 Rust、启动或重启 Electron，也没有提交。
- 当前仅完成 Storybook 实现切片，对应实施 Plan 已删除；后续由用户逐页确认并决定业务接入范围。
