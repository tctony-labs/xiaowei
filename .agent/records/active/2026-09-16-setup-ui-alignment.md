# 建立 UI 对齐流程

## Why

后续页面与交互迁移需要可重复的验收流程。将旧项目源码和实际表现作为基准，避免凭印象重写，也避免 UI 开发等待业务后台。

## What

接入免费的本地 Storybook，以 Launcher 为首个样例。桌面与 Storybook 使用同一组件，固定尺寸、主题和输入状态进行对照。当前不接入云端设计服务或自动截图基线平台。

## How

- 先采集旧 UI 的结构、样式参数和状态清单，标记原样迁移、明确调整、暂缓。
- 从页面提取不依赖 Electron、Rust 或后台的 React 组件，通过 props 与回调连接业务。组件旁维护 stories，固定模拟数据并覆盖键盘和输入状态。
- 设计变量统一维护在 renderer 样式中。Storybook 引入同一份 CSS，明暗主题可独立切换。
- 先对比组件场景，再接入 Electron 验收原生窗口、全局快捷键、失焦和输入法；Storybook 不能替代原生验证。
- 尚未实现的行为不展示为可用功能；调整需在对应迁移 record 写明理由。视觉基线经用户确认后再固化，不能把新实现自动当成旧版基准。

## Outcome

已接入 Storybook 10.6，提供 `just storybook` 与静态构建命令。产品和预览复用 LauncherSearchBar，建立空输入、有输入、长文本、固定深色与 Esc 交互五个场景。配置自动 JSX 转换和同一份 Tailwind 样式；关闭 Storybook 遥测。

`pnpm check`、桌面生产构建及 Storybook 静态构建通过。通过用户现有 Chrome 验证空输入布局 800 × 71、输入字号 16px、自动聚焦，深色背景为旧版 #141414，Esc 清空和关闭回调的 play 测试显示 PASS。没有冷启动 Electron；原生交互验收仍由 Launcher 事项跟踪。搜索框视觉样式已于 2026-09-16 获用户确认，尚未建立自动截图回归。

持续开发流程与场景说明见 [UI 对齐与 Storybook](../../../docs/ui-alignment.md)。Storybook 预览已在本地 6006 端口启动供用户评审。

后续补充组合输入 Esc 与重新聚焦全选两个场景，Chrome 中均显示 PASS。当前共七个场景；原生交互仍由 Launcher 事项跟踪。
