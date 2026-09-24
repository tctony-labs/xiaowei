# 建立 UI 对齐流程

## Why

后续页面与交互迁移需要可重复的验收流程。将旧项目源码和实际表现作为基准，避免凭印象重写，也避免 UI 开发等待业务后台。

## What

接入免费的本地 Storybook，以 Launcher 为首个样例。桌面与 Storybook 使用同一组件，固定尺寸、主题和输入状态进行对照。当前不接入云端设计服务或自动截图基线平台。

## How

通用组件边界、主题约定、Storybook 流程和视觉验收要求统一维护在 [Renderer UI 开发](../../../desktop/src/renderer/README.md)。具体组件的设计决定和验收结果由对应事项记录，场景与测试清单以源码为准。

## Outcome

已接入 Storybook 10.6，提供 `just storybook` 与静态构建命令。产品和预览复用 LauncherSearchBar，建立空输入、有输入、长文本、固定深色与 Esc 交互五个场景。配置自动 JSX 转换和同一份 Tailwind 样式；关闭 Storybook 遥测。

`pnpm check`、桌面生产构建及 Storybook 静态构建通过。通过用户现有 Chrome 验证空输入布局 800 × 71、输入字号 16px、自动聚焦，深色背景为旧版 #141414，Esc 清空和关闭回调的 play 测试显示 PASS。没有冷启动 Electron；原生交互验收仍由 Launcher 事项跟踪。搜索框视觉样式已于 2026-09-16 获用户确认，尚未建立自动截图回归。

首个样例的视觉基线及原生验收结果见 [Launcher 事项](2026-09-16-migrate-launcher.md)。

后续补充组合输入 Esc 与重新聚焦全选两个场景，Chrome 中均显示 PASS。当前共七个场景；原生交互仍由 Launcher 事项跟踪。

2026-09-18 用户确认移除全局默认 focus outline，保留焦点行为，由组件负责选中与焦点视觉。品牌绿色与普通字号文字的可读性用色分开维护，不要求主色与 Logo 像素颜色完全一致；当前通用约定见 renderer README，具体色值以样式源码为准。

2026-09-24 文档整理：通用规范集中到 renderer README，组件设计与验收信息归入对应事项，删除重复的 `docs/ui-alignment.md`。本次只调整文档，不改变 UI 或验收结论。
