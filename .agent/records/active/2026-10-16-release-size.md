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

后续用户授权继续裁剪依赖中不需要的其他环境代码。范围为 Google GenAI 的 Web／通用构建、polyfill／protobuf 浏览器构建以及 AWS／Smithy 等 Node 未选中的环境分支；按独立优化点验证并提交。该阶段不包含类型／TS 源码、原生模块合并或 LTO。

用户随后同意继续清理类型声明与 SDK 原始 TypeScript 源码，分别验证并提交；已 bundled 的内部包独立副本仅解释其含义，未获本轮实施授权，保持现状。

用户现要求重新从构建和依赖声明源头控制分发：纯 JS／TS 默认 bundled，只有 native 包与必要资源显式外置；此前被替代的逐包文件删除规则可以回退。当前已进入实施阶段，实施细节见 [构建与分发边界 Plan](../../plans/2026-10-16-release-size/01-runtime-package-boundary.md)。

验收包括打包配置／失败路径回归、实际目录包的语言和 ASAR 内容检查、原生导出与加载验证、体积测量。构建和 Node 加载不替代真实 Electron 交互验收；Agent 不冷启动应用，不覆盖已安装正式包，不发布；用户已授权每个优化点单独提交。

## How

实施前测量：220 份 Electron `locale.pak` 合计 48.0 MiB，仅保留 `zh_CN` 和 `en` 可减少约 46.9 MiB；依赖 source map 合计 17.6 MiB；React／React DOM／React Markdown／remark-gfm／zustand／scheduler 的重复副本约 8.0 MiB；临时副本 `strip -x` 合计减少约 9.1 MiB。收益基于 0.1.1，当前源码重新构建后的最终结果另行测量，不能视为同源码对照。

语言复用 electron-builder 的语言筛选。Source map 与依赖打包边界独立：原先使用文件过滤排除；新方案在 main／preload／renderer 构建目标显式设置 `sourcemap: false`，验证构建与分发产物均无 map，下一切片移除旧文件过滤。原生裁剪接入既有 `scripts/dev/build-napi.mjs` 的 macOS `--release` 路径，仅处理本次生成的 release `.node`，debug 不裁剪；输出前后字节数，构建或裁剪失败立即退出。

原方案考虑在 `afterPack` 处理打包副本，但核实 ASAR 会记录 unpacked 原生文件的大小与哈希，而 hook 发生在元数据生成后。改为 release 构建后立即裁剪，使 CI 的功能测试和 SHA-256 保护、ASAR 元数据及最终签名均基于相同产物。签名仍由既有 electron-builder 流程负责。

## Current work

- 已创建 `br/chore_release_size`；语言裁剪已完成：实际 ad-hoc 目录包仅有 `zh_CN.lproj` 与 `en.lproj` 的 `locale.pak`，五个 addon 加载与包签名校验通过；相同 Electron 版本对应语言资源减少约 46.9 MiB。发布相关 27 项回归通过，提交 hook 的 `just check` 作为每次提交的必需检查。
- source map 排除已完成：同一份 release 构建重新打包后，ASAR 中 `.map` 数量从 2,684 降至 0；五个 addon 加载、签名及发布元数据校验通过。语言裁剪后的目录包为 361,504,097 bytes，source map 排除后的体积将在最终对照表汇总。
- 重复前端依赖已剔除：五个仅用于 renderer 的包移入 `devDependencies`，由 pnpm 同步锁文件；真实 ASAR 不再包含这些包和 scheduler。构建输出的 renderer JS 文件名和体积保持一致；源码消费／renderer 打包检查与 138 项 renderer 测试通过，五个打包 addon 加载和签名校验通过。
- 四项实现及自动验收均已完成，结果见 Outcome。待用户启动新目录包验收中文／英文与其他系统语言的回退、窗口显示、剪贴板／搜索／Agent 和更新界面；Agent 未冷启动应用，保留 active。
- 其他环境代码裁剪四组实现及实际包隔离验证已完成，结果见下表。目录包现在为 300.020 MiB；未冷启动，仍待用户进行 Electron GUI 与正式发布链路验收。
- 类型声明与 OpenAI／Anthropic SDK 原始 TypeScript 源码均已裁剪并通过实际包隔离验证。目录包更新为 291.937 MiB；内部包副本未修改，仍待用户进行 Electron GUI 与正式发布链路验收。
- 新方案第一切片已实施：main／preload 关闭自动外置，只显式外置五个 native 包；Bedrock 用公开 lazyApi 加字面量动态 import 生成独立 chunk；各目标显式关闭 source map。构建及输出依赖边界检查通过，工作区外无 node_modules 的隔离 worker 完成十种 provider chunk 加载、三种 HTTP/SSE provider 请求与失败／取消／关闭，以及 WebSocket 复用与取消。下一步收紧 production dependencies、移除旧规则并验收实际目录包。

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

### 构建边界调整（实施中）

默认 bundle 切片已替代 main／worker 的纯 JS 运行时外置方式；第三方源码本身未改动。构建边界回归在旧配置上先因 `electron-log/node` 外置失败，再通过新配置；显式 Bedrock 动态入口生成独立 chunk。隔离测试只复制 main 构建产物及 `type: module` 元数据，不复制工作区或 SDK node_modules，plain Node 创建的 worker 可加载十种 provider 的实现；本地 HTTP/SSE 验证 OpenAI Completions／Responses 与 Anthropic Messages 的生成、错误、取消和关闭，WebSocket 验证连接复用与取消。provider chunk 引用 worker 入口的共用代码，因此加载验收保持 worker 上下文，不在主线程强行导入。

此切片 desktop 构建、构建源码／外部依赖／source map 回归、71 项 LLM 测试和 59 项 main 测试均通过。

未安装的可选 Kerberos peer 在构建中保留为仅在调用时失败的 stub，沿用现有依赖能力；隔离加载验收针对十种实际 provider 入口，不强行执行所有可选功能 chunk。真实云端认证、Kerberos 代理和 Electron GUI 不在此次自动验证结果中。

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

### 类型声明与 SDK 原始源码

用户同意分别清理声明和 SDK 源码，保持 Gateway／contracts 等内部包独立副本不变。沿用上一轮目录包及相同 release 原生产物，只增加发布过滤。

| 阶段 | 逻辑字节数 | 本步减少 |
| --- | ---: | ---: |
| 其他环境清理完成 | 314,594,133 | — |
| 类型声明裁剪 | 310,377,318 | 4.021 MiB |
| OpenAI／Anthropic 原始源码裁剪 | 306,118,222 | 4.062 MiB |

声明基线为 3,917,343 bytes，主要来自 OpenAI、Anthropic 与 TypeBox 的 `.d.mts`。新增发布排除 `.d.ts`／`.d.mts`／`.d.cts` 后，实际 ASAR 的声明文件为 0；包含 ASAR 元数据后减少 4.021 MiB，Node JS 入口保留。

实际包解包隔离验证通过：十种 provider、Google Node ESM／CJS／tokenizer、96 次 AWS／Smithy 公共入口解析、stream／Blob／protobuf、Node helper 与本地 WebSocket、包内 worker 启动；额外覆盖 TypeBox 正确／错误数据的 schema 校验。Google fetch 替身校验 URL、POST、API key header 与请求内容，再验证响应文本；Bedrock handler 校验 POST 与签名头格式，再解码模拟响应。未独立复算 Bedrock 签名、未测试真实云端鉴权和网络。此前记录中的“请求签名验证”准确含义为经过 SDK 签名流程，不能视为签名内容的独立校验。

OpenAI 6.40.0 与 Anthropic 0.124.0 的运行时 exports 不指向 `src`，编译后的 JS 未发现对这两个原始源码目录的导入。发布过滤只排除这两个 SDK 的 `src/`，保留其他库的运行源码与所有 SDK 编译后 ESM／CJS 入口。实际 ASAR 中声明文件及两个 SDK 原始目录均不存在；内部 Gateway／contracts／protobuf 的 236 个保留文件与裁剪前逐文件 SHA-256 对照一致。

从新 ASAR 隔离解包后，分别调用 OpenAI 与 Anthropic 的 ESM 和 CJS 客户端，共四次 fetch 替身请求，校验 API 路径、POST、鉴权头和请求消息，并断言 SDK 解析出预期响应文本；前述 provider／Google／Bedrock／schema／stream／protobuf／WebSocket／worker 验证全部继续通过。polyfill 主入口验证改为独立 Node 子进程，避免它替换全局 ReadableStream 后污染 HTTP Response 测试；这属于验证脚本隔离修正，未改变应用实现。

本阶段累计减少 8.083 MiB（含 ASAR 元数据），实际目录包为 306,118,222 bytes（291.937 MiB）。类型声明和 SDK 源码各自单独提交，提交 hook 执行 `just check`。只修改分发过滤和相关文档，开发依赖源码保留；工作区原生包恢复 debug 构建，release 目录包通过签名、版本、arm64 和五个 addon 加载检查。临时验证目录及哈希快照已清理。

## 后续工作

- 压缩与代码混淆暂不实施。当前 electron-vite 5 的 main（含 LLM worker）／preload 默认 `minify: false`，renderer 生产构建默认压缩，项目未配置专门混淆。后续独立评估 main／worker／preload 开启压缩后的体积、启动和 provider 行为，并确认函数名／错误栈对日志排障的影响；专门混淆另行评估体积、运行性能和排障成本，压缩或关闭 source map 不视为防止 JS 被分析的保护措施。

- 如继续评估 OpenAI／Anthropic 等 SDK 在 Node 内的 ESM／CJS 双格式重复，需要单独追踪交叉引用；本轮保留必要的两种格式，不按扩展名统一删除。
- 已 bundled 的内部 Gateway／contracts／protobuf 独立包副本仅完成说明，本轮未处理。若用户后续授权，需先确认所有 main／worker／preload 入口均不再依赖其独立运行文件，再裁剪重复副本。
- Rust LTO 暂缓，用户已明确先不处理；原定评估为对比 `thin`／完整 LTO 的体积、构建时间与功能回归，收益尚未测量。
- 如继续评估 SwiftShader（约 15.9 MiB），先明确 GPU 不可用时的软件图形回退与兼容性要求。
- 新正式版本仍需 Developer ID 签名／公证、安装及 Sparkle 更新验收；本地 ad-hoc 目录包不能替代。
