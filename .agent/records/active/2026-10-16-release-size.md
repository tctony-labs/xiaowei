# macOS release 体积优化

## Why

已安装 `/Applications/XiaoWei.app` 0.1.1（Electron 44.3.0、arm64）的普通文件逻辑体积为 410,595,485 bytes，约 391.6 MiB；磁盘占用约 392.8 MiB。检查发现完整语言资源、依赖 source map、已 bundled 的前端依赖副本和原生模块本地符号仍进入分发包。用户要求建立本事项台账，先实施四项确定的优化，并记录后续工作。

| 基线组成 | 逻辑体积 |
| --- | ---: |
| Electron Framework | 284.5 MiB |
| app.asar | 60.3 MiB |
| app.asar.unpacked | 40.7 MiB |
| 其余框架和资源 | 6.1 MiB |

## What

本轮保留简体中文和英文 Electron 语言资源，排除 release 中所有 `.map` 文件，剔除已经 bundled 的前端运行库副本，并在 macOS 包签名前对五个生产 `.node` 执行 `strip -x`。保留必要的原生导出与加载入口，保持开发构建、LLM provider、更新签名与公证流程正常。

验收包括打包配置／失败路径回归、实际目录包的语言和 ASAR 内容检查、原生导出与加载验证、体积测量。构建和 Node 加载不替代真实 Electron 交互验收；Agent 不冷启动应用，不覆盖已安装正式包，不发布或提交。

## How

实施前测量：220 份 Electron `locale.pak` 合计 48.0 MiB，仅保留 `zh_CN` 和 `en` 可减少约 46.9 MiB；依赖 source map 合计 17.6 MiB；React／React DOM／React Markdown／remark-gfm／zustand／scheduler 的重复副本约 8.0 MiB；临时副本 `strip -x` 合计减少约 9.1 MiB。收益基于 0.1.1，当前源码重新构建后的最终结果另行测量，不能视为同源码对照。

优先复用 electron-builder 的语言筛选、文件过滤和签名前 hook，不改变应用业务边界。source map 只从分发产物排除，原生裁剪只处理打包副本，不修改工作区构建产物。

## Current work

- 已创建 `br/chore_release_size`，开始实现四项优化及自动验证。
- 待测量实际新目录包，回填本轮结果与仍需用户启动的运行验收。

## 后续工作

- 评估 SDK 的 ESM／CJS／Web／Node 多份构建与 polyfill 变体裁剪；按实际导入路径验证，不能整包删除生产 AI SDK。
- 核实类型声明和 TypeScript 源码的运行时入口后按需裁剪；原基线中分别约 3.75 MiB 与 4.30 MiB，与依赖移除可能重叠。
- 评估 Rust LTO：保留 LLVM 中间表示，在链接阶段跨 crate／编译单元优化、内联和移除无用代码；对比 `thin`／完整 LTO 的体积、构建时间与功能回归。本轮不启用，收益尚未测量。
- 如继续评估 SwiftShader（约 15.9 MiB），先明确 GPU 不可用时的软件图形回退与兼容性要求。
- 新正式版本仍需 Developer ID 签名／公证、安装及 Sparkle 更新验收；本地 ad-hoc 目录包不能替代。
