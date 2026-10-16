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

后续用户授权继续裁剪依赖中不需要的其他环境代码。范围为 Google GenAI 的 Web／通用构建、polyfill／protobuf 浏览器构建以及 AWS／Smithy 等 Node 未选中的环境分支；按独立优化点验证并提交。不在本轮清理类型／TS 源码、合并原生模块或启用 LTO。

验收包括打包配置／失败路径回归、实际目录包的语言和 ASAR 内容检查、原生导出与加载验证、体积测量。构建和 Node 加载不替代真实 Electron 交互验收；Agent 不冷启动应用，不覆盖已安装正式包，不发布；用户已授权每个优化点单独提交。

## How

实施前测量：220 份 Electron `locale.pak` 合计 48.0 MiB，仅保留 `zh_CN` 和 `en` 可减少约 46.9 MiB；依赖 source map 合计 17.6 MiB；React／React DOM／React Markdown／remark-gfm／zustand／scheduler 的重复副本约 8.0 MiB；临时副本 `strip -x` 合计减少约 9.1 MiB。收益基于 0.1.1，当前源码重新构建后的最终结果另行测量，不能视为同源码对照。

语言和 source map 复用 electron-builder 的语言筛选与文件过滤，不改变应用业务边界。source map 只从分发产物排除。原生裁剪接入既有 `scripts/dev/build-napi.mjs` 的 macOS `--release` 路径，仅处理本次生成的 release `.node`，debug 不裁剪；输出前后字节数，构建或裁剪失败立即退出。

原方案考虑在 `afterPack` 处理打包副本，但核实 ASAR 会记录 unpacked 原生文件的大小与哈希，而 hook 发生在元数据生成后。改为 release 构建后立即裁剪，使 CI 的功能测试和 SHA-256 保护、ASAR 元数据及最终签名均基于相同产物。签名仍由既有 electron-builder 流程负责。

## Current work

- 已创建 `br/chore_release_size`；语言裁剪已完成：实际 ad-hoc 目录包仅有 `zh_CN.lproj` 与 `en.lproj` 的 `locale.pak`，五个 addon 加载与包签名校验通过；相同 Electron 版本对应语言资源减少约 46.9 MiB。发布相关 27 项回归通过，提交 hook 的 `just check` 作为每次提交的必需检查。
- source map 排除已完成：同一份 release 构建重新打包后，ASAR 中 `.map` 数量从 2,684 降至 0；五个 addon 加载、签名及发布元数据校验通过。语言裁剪后的目录包为 361,504,097 bytes，source map 排除后的体积将在最终对照表汇总。
- 重复前端依赖已剔除：五个仅用于 renderer 的包移入 `devDependencies`，由 pnpm 同步锁文件；真实 ASAR 不再包含这些包和 scheduler。构建输出的 renderer JS 文件名和体积保持一致；源码消费／renderer 打包检查与 138 项 renderer 测试通过，五个打包 addon 加载和签名校验通过。
- 四项实现及自动验收均已完成，结果见 Outcome。待用户启动新目录包验收中文／英文与其他系统语言的回退、窗口显示、剪贴板／搜索／Agent 和更新界面；Agent 未冷启动应用，保留 active。
- 其他环境代码裁剪四组实现及实际包隔离验证已完成，结果见下表。目录包现在为 300.020 MiB；未冷启动，仍待用户进行 Electron GUI 与正式发布链路验收。

## Outcome

本轮实现与发布约定见 [macOS 打包与更新](../../../desktop/docs/macos-release.md)。每个优化点单独提交，同时回填本记录；无提交 AI 署名，无发布、覆盖安装或修改根 docs。

使用当前源码构建五个 release addon 和 desktop，逐项复用相同构建产物打 ad-hoc 目录包，测得：

| 阶段 | 普通文件逻辑字节数 | MiB | 本步减少 |
| --- | ---: | ---: | ---: |
| 已安装 0.1.1 基线 | 410,595,485 | 391.574 | — |
| 当前源码＋仅保留中文／英文 | 361,504,097 | 344.757 | 语言资源本身约 46.9 MiB |
| 再排除 source map | 342,337,649 | 326.479 | 18.279 MiB（包含 ASAR 元数据） |
| 再移除重复前端依赖 | 332,216,062 | 316.826 | 9.654 MiB |
| 再裁剪原生本地符号 | 322,596,822 | 307.652 | 9.174 MiB（包含重新签名后的差异） |

首轮目录包为忽略的 `desktop/dist/mac-arm64/XiaoWei.app`，后续优化继续更新该路径。首轮相对已安装基线减少约 83.922 MiB（21.43%）；基线与当前源码并非同一提交，语言包以外的三步则是本次连续构建产物对照。此版本号仍为 0.1.1，仅用于本地验收，不作为新正式版本发布。

验证结果：

- 实际 ASAR 中 `.map` 为 0，React、React DOM、React Markdown、remark-gfm、zustand、scheduler 的独立副本均不存在；Electron `locale.pak` 仅有 `en` 与 `zh_CN`。
- 新增裁剪成功、debug／非 macOS 不裁剪、原生构建失败、裁剪失败四项回归，先确认旧实现缺少裁剪及失败传播时测试失败，再实现并通过；与发布相关测试共 31 项通过。新增测试已纳入 release CI 的 prebuilt 测试入口。
- 五个真实裁剪 addon 的 Mach-O 全局导出符号和 JS 导出／原型与裁剪前一致，全部可加载。Search 5、Storage 1、Platform 3、Clipboard 3、Agent 5，共 17 项原生运行测试通过，覆盖数据库、业务调用、LLM worker、失败、取消及关闭。
- renderer 源码消费与 React／Markdown bundled 检查通过，138 项 renderer 测试通过，依赖分类调整前后的 renderer JS 文件名和大小一致。
- 打包入口实际通过 arm64 检查、五个 addon 加载、`codesign --verify --deep --strict`、版本与 Sparkle 元数据检查。
- 将最终 ASAR 解包到临时隔离目录后，十种 Pi provider 的实际实现均成功导入，包内 LLM worker 使用包内依赖启动成功；未调用远程模型。临时目录已删除。
- 五个 `build:debug` 入口重新构建通过，未触发裁剪；工作区恢复 debug 产物，已打包的 release 副本保留裁剪结果。各提交由既有 pre-commit hook 执行 `just check`。

尚未验证：真实 Electron GUI、非中文／英文系统语言回退、Developer ID／公证与正式更新链路。需由用户启动新目录包并按发布文档完成交互验收；ad-hoc、Node 加载和 worker 检查不替代这些项目。

### 其他环境代码裁剪

用户要求继续处理未使用的其他环境构建，复用首轮相同源码及 release 构建；只增加发布文件过滤，不修改已安装依赖或生产业务逻辑。

| 阶段 | 逻辑字节数 | 本步减少 |
| --- | ---: | ---: |
| 首轮优化完成 | 322,596,822 | — |
| Google GenAI Web／通用构建 | 319,481,137 | 2.971 MiB |
| stream polyfill 脚本变体 | 317,195,900 | 2.179 MiB |
| protobuf 独立浏览器 bundles | 316,369,690 | 0.788 MiB |
| SDK／支撑依赖非 Node 分支 | 314,594,133 | 1.693 MiB |

Google GenAI 的 Node 条件入口指向 `dist/node`；排除 `dist/web` 与顶层通用 `index.mjs`／`index.cjs`，保留 Node ESM／CJS、tokenizer、Vertex 支撑代码。从实际 ASAR 解包到隔离临时目录后，十种 provider 实现、Google Node ESM／CJS 与 tokenizer 均成功加载；用本地 fetch 替身验证 Google 内容生成请求及响应解析，同时验证 stream ponyfill、fetch-blob、protobuf 编解码和包内 LLM worker 启动。未访问远程模型，临时目录已删除；打包入口的签名、元数据及五个原生模块加载校验通过。

stream polyfill 排除未使用的模块／目标版本和浏览器压缩构建，保留 Node 主入口 `polyfill.js` 与 fetch-blob 显式引用的 `ponyfill.es2018.js`。对实际新 ASAR 重新执行上述隔离验证，并验证 polyfill 主入口、ponyfill 可读流和 Blob 文本读取，全部通过；实际目录包减少 2.179 MiB。

protobuf Node 根入口和 `minimal.js` 都引用 `src`，排除只面向浏览器独立加载的 `dist` 后，再次通过上述验证；实际 Node protobuf 消息编码／解码和 Google tokenizer 导入正常。同步核实 AWS／Smithy 共 96 次 Node import／require 公共入口解析，全部指向保留的 Node 文件；用本地 request handler 验证 Bedrock 请求签名及响应解析，未访问云端。31 项发布／原生构建回归通过。

SDK／支撑依赖裁剪 AWS／Smithy 未被 Node 选择的 `dist-es`、Smithy 的 browser／React Native CJS 分支、Anthropic 浏览器入口、gaxios 浏览器测试、ws／debug 浏览器入口及 Bowser 独立 bundle。最终实际 ASAR 中这些目标均不存在，96 次 AWS／Smithy 公共入口解析、Bedrock 本地请求签名／响应解析及前述 Google／protobuf／stream／provider／worker 验证全部通过；新增 Node debug、Bowser UA 解析与本地 WebSocket 消息往返验证通过。

不能根据名称统一删除 browser／native 文件：Google Auth 的 Node 入口仍无条件导入 `crypto/browser/crypto.js`；OpenAI 的 `ws-adapter-browser` 支撑全局 WebSocket；Bowser 的 `parser-browsers` 和 TypeBox 的 `guard/native.mjs` 也不是可按名称剔除的其他环境代码。已在最终 ASAR 确认所需实现保留。

本轮在同源码目录包中累计减少 7.632 MiB，最终为 314,594,133 bytes（300.020 MiB）。相对最初已安装 0.1.1 基线减少约 91.554 MiB（23.38%，基线源码存在差异）；版本、业务实现、依赖版本、原生接口未改变。每组修改与记录分别提交，提交 hook 执行 `just check`；五个原生包最后恢复 debug 构建，最终目录包仍保留 release 裁剪副本。目录包签名、原生加载、语言筛选、无 source map／重复前端依赖的检查继续通过。临时解包验证目录已清理，未访问远程模型，未发布或覆盖已安装应用。

## 后续工作

- 如继续评估 OpenAI／Anthropic 等 SDK 在 Node 内的 ESM／CJS 双格式重复，需要单独追踪交叉引用；本轮保留必要的两种格式，不按扩展名统一删除。
- 核实类型声明和 TypeScript 源码的运行时入口后按需裁剪；原基线中分别约 3.75 MiB 与 4.30 MiB，与依赖移除可能重叠。
- Rust LTO 暂缓，用户已明确先不处理；原定评估为对比 `thin`／完整 LTO 的体积、构建时间与功能回归，收益尚未测量。
- 如继续评估 SwiftShader（约 15.9 MiB），先明确 GPU 不可用时的软件图形回退与兼容性要求。
- 新正式版本仍需 Developer ID 签名／公证、安装及 Sparkle 更新验收；本地 ad-hoc 目录包不能替代。
