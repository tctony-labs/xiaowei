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

用户随后同意继续清理类型声明与 SDK 原始 TypeScript 源码，分别验证并提交；该阶段尚未修改已 bundled 的内部包独立副本。

用户随后要求重新从构建和依赖声明源头控制分发：纯 JS／TS 默认 bundled，只有 native 包与必要资源显式外置；此前被替代的逐包文件删除规则可以回退。构建与分发边界现已实施并通过自动验收，结果见 Outcome，当前约定见 [macOS 打包与更新](../../../desktop/docs/macos-release.md)。

验收包括打包配置／失败路径回归、实际目录包的语言和 ASAR 内容检查、原生导出与加载验证、体积测量。构建和 Node 加载不替代真实 Electron 交互验收；Agent 不冷启动应用，不覆盖已安装正式包，不发布；用户已授权每个优化点单独提交。

## How

实施前测量：220 份 Electron `locale.pak` 合计 48.0 MiB，仅保留 `zh_CN` 和 `en` 可减少约 46.9 MiB；依赖 source map 合计 17.6 MiB；React／React DOM／React Markdown／remark-gfm／zustand／scheduler 的重复副本约 8.0 MiB；临时副本 `strip -x` 合计减少约 9.1 MiB。收益基于 0.1.1，当前源码重新构建后的最终结果另行测量，不能视为同源码对照。

语言复用 electron-builder 的语言筛选。Source map 与依赖打包边界独立：原先使用文件过滤排除；新方案在构建阶段关闭生成，并验证构建与分发产物，旧的 source map 文件过滤已移除。当前打包边界与维护入口统一见 [macOS 打包与更新](../../../desktop/docs/macos-release.md)。原生裁剪接入既有 `scripts/dev/build-napi.mjs` 的 macOS `--release` 路径，仅处理本次生成的 release `.node`，debug 不裁剪；输出前后字节数，构建或裁剪失败立即退出。

原方案考虑在 `afterPack` 处理打包副本，但核实 ASAR 会记录 unpacked 原生文件的大小与哈希，而 hook 发生在元数据生成后。改为 release 构建后立即裁剪，使 CI 的功能测试和 SHA-256 保护、ASAR 元数据及最终签名均基于相同产物。签名仍由既有 electron-builder 流程负责。

## Current work

- 用户已授权继续实施两个 addon：常规桌面能力通过 npm `xiaowei-rust`／Cargo `xiaowei-rust-napi` 汇入同一 `.node`，Agent 保持 `xiaowei-agent`／`xiaowei-agent-napi`。Search／Clipboard／Storage 核心改名为 `xw-*`，删除 Platform 转发壳，直接使用 `xw-platform`；proto 与 Gateway 路由保持原名。新增 npm／绑定包放在 `crates/xiaowei-rust/napi/`，根目录只承载说明，不创建空的转发 crate。
- 核心改名切片已完成；后续按 [两个 addon Plan](../../plans/2026-10-16-release-size/03-two-native-addons.md) 实施、验证并分切片提交；同步更新当前架构与发布文档。已有 278.488 MiB 目录包作为本轮前置基线。

- 构建与分发边界已实现并通过自动验收：纯 JS bundled、provider 懒加载 chunk、native 生产依赖及明确文件清单。旧的逐 SDK／环境／声明／源码／source map 过滤均已移除。
- 分发边界调整后为 280.654 MiB；本次再启用 release JS minify，最新 ad-hoc 目录包为 292,015,646 bytes（278.488 MiB），再减少 2.166 MiB。ASAR 仍只有 74 个文件，五个签名后二进制 SHA-256 保持一致。
- minify 后重新通过构建压缩／依赖边界回归、73 项 LLM 测试、59 项 main 测试及 43 项发布回归；实际新包另通过 7 项 provider／worker 隔离测试及五个 native 包加载器。此前原生裁剪相关检查结果保留在 Outcome。
- 前序 JS／分发优化代码与发布说明已完成，其实施 Plan 已删除；当前继续实施 native 合并。用户对前序目录包反馈打包模式粗略测试正常；未逐项确认语言回退或全部交互场景。正式签名／公证／Sparkle 更新留待发布时验收，record 保留 active。

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

首轮自动验收未覆盖真实 Electron GUI、非中文／英文系统语言回退、Developer ID／公证与正式更新链路；ad-hoc、Node 加载和 worker 检查不替代这些项目。后续用户对最新 minify 目录包的粗略测试结果见下文。

### 构建与分发边界调整

默认 bundle 切片已替代 main／worker 的纯 JS 运行时外置方式；第三方源码本身未改动。构建边界回归在旧配置上先因 `electron-log/node` 外置失败，再通过新配置；显式 Bedrock 动态入口生成独立 chunk。隔离测试只复制 main 构建产物及 `type: module` 元数据，不复制工作区或 SDK node_modules，plain Node 创建的 worker 可加载十种 provider 的实现；本地 HTTP/SSE 验证 OpenAI Completions／Responses 与 Anthropic Messages 的生成、错误、取消和关闭，WebSocket 验证连接复用与取消。provider chunk 引用 worker 入口的共用代码，因此加载验收保持 worker 上下文，不在主线程强行导入。

此切片 desktop 构建、构建源码／外部依赖／source map 回归、71 项 LLM 测试和 59 项 main 测试均通过。

未安装的可选 Kerberos peer 在构建中保留为仅在调用时失败的 stub，沿用现有依赖能力；隔离加载验收针对十种实际 provider 入口，不强行执行所有可选功能 chunk。真实云端认证、Kerberos 代理和 Electron GUI 不在此次自动验证结果中。

第二切片将 pi-ai、electron-log、Gateway、contracts 和 protobuf 移到 desktop 的 devDependencies，生产依赖只保留五个 native 包；pnpm 生成锁文件，依赖版本未升级。macOS 打包输入改为 out 与明确的 native 加载器／package.json／darwin-arm64 二进制清单，不再按 SDK 删除文件。electron-builder 会独立遍历生产包、忽略其 npm files，因此在其 FileSet 过滤器中先重置默认全选，再显式声明允许文件；实际 ASAR 验证确认该规则也阻止 native Rust／Cargo 源码进入。

新增最终 ASAR 与 unpacked 内容验证，拒绝多余运行包、工作区源码、声明、map 或 inline map 引用，以及缺失加载器／二进制。验证接入全部发布阶段的 app 检查，失败会阻止 DMG／ZIP 后续制作。原生二进制在签名后可能比 ASAR 头记录更长，内容边界验证不据头部字节数判定损坏；原生有效性仍经架构、签名与实际加载检查。

| 项目 | 边界调整前 | 调整后 | 减少 |
| --- | ---: | ---: | ---: |
| 整个目录包 | 306,118,222 bytes（291.937 MiB） | 294,287,179 bytes（280.654 MiB） | 11.283 MiB |
| app.asar | 17,606,606 bytes（16.791 MiB） | 5,842,916 bytes（5.572 MiB） | 11.219 MiB |
| app.asar.unpacked | 33,084,341 bytes（31.552 MiB） | 33,024,718 bytes（31.495 MiB） | 0.057 MiB |

五个签名后 native 二进制大小及逐文件 SHA-256 与调整前一致；unpacked 的差异来自移除额外 Rust／Cargo 文件，应用整体差额还包含代码签名元数据变化。最终 ASAR 只有 out、应用 package.json，以及五个 native 包各自三个文件；共 74 个文件，没有独立纯 JS 运行包、原始源码／声明和 source map。Electron locale.pak 仍只有 en 与 zh_CN。

通过既有打包入口生成真实 ad-hoc 目录包后，签名、版本、Sparkle 元数据、arm64 与五个二进制加载均通过。再将实际 ASAR 解包到工作区外，通过其五个生成加载器加载 native；只复制该包 main 输出到另一无 node_modules 的目录，plain Node worker 加载十种 provider chunk，7 项隔离测试通过。新增 Google 本地 SSE 生成／鉴权头／请求正文检查，以及 Bedrock 本地 HTTP/1 请求与 403 错误响应检查；Bedrock 使用 SDK 的 dummy-credential 模式，验证 AWS4 签名头格式和请求正文，不涉及真实云端认证或独立签名复算。临时目录全部清理。

最终配置再次生成目录包并通过同样的 7 项实际包隔离测试与五个 native 加载器；应用总字节数保持 294,287,179。五个工作区 native 包已重新构建为 debug，未触发 strip；目录包保留 release 裁剪副本。

调整后 73 项 LLM 测试及 48 项构建／发布回归通过，包含真实 ASAR 成功与失败边界、发布内容失败后阻断后续制作。构建源码与产物内容检查已加入 release CI prebuilt 入口；isolated worker 测试由既有 desktop 测试通配入口覆盖。

### 内部 Rust 核心改名

已将 Search／Clipboard／Storage 核心迁移为 `xw-search`／`xw-clipboard`／`xw-storage`，同步目录、Cargo 依赖、Rust 引用、service binding 输出位置与当前文档链接。原有 napi npm 包暂留旧位置，作为可独立验证的第一切片；proto 包名、完整路由、临时资源前缀和数据布局均未修改。

三个核心共 90 项 Rust 测试通过，三个受影响 napi 包构建及 9 项绑定测试通过，契约／Gateway 生成一致性检查通过。Cargo 锁文件只保留工作区包改名；核对第三方包的 name／version／source 集合与切片前完全相同。最初完整重新解析引入的无关派生宏版本变化已撤销，使用原锁文件由 Cargo 增量同步。

### Release JS minify

用户决定项目本身开源，不采用源码混淆，随后授权仅做常规 minify。main（含 LLM worker）和 preload 的 build 命令显式使用 esbuild minify；serve 开发入口不压缩，renderer 继续沿用原有生产默认值。不新增依赖、混淆或 bytecode 接入，不改变 source map、native 外置与 provider chunk 边界。

构建回归先在旧配置上因实际 main 输出没有缩小而失败；实现后用相同配置关闭 minify 的内存构建作对照，确认 main／preload 的生产输出确实更小，并确认 serve 的配置不压缩。源代码消费、Bedrock 懒加载、外部依赖及 source map 检查继续通过。

| 项目 | 压缩前字节数 | 压缩后字节数 |
| --- | ---: | ---: |
| main（含 worker 和 provider chunks） | 4,123,722 | 1,852,854 |
| preload | 1,213 | 576 |
| renderer（含静态资源） | 1,697,256 | 1,697,256 |
| app.asar | 5,842,916 | 3,571,383 |
| 整个目录包 | 294,287,179 | 292,015,646 |

实际目录包从 280.654 MiB 降至 278.488 MiB，减少 2,271,533 bytes（2.166 MiB）。renderer 大小及构建的内容哈希文件名保持一致；五个签名后的 native 二进制逐文件 SHA-256 与 minify 前一致。

验证：desktop 构建、构建压缩／边界回归、73 项 LLM 测试、59 项 main 测试及 43 项发布回归通过。通过既有入口生成真实 ad-hoc 包后，ASAR 内容、签名、版本／更新元数据、arm64 与五个 addon 加载检查均通过。解包到工作区外，用该包 main 输出重跑 7 项隔离测试并通过五个 native 生成加载器；涵盖十种 provider chunk 加载、HTTP/SSE、WebSocket、Google 生成与 Bedrock 本地错误响应、失败、取消和关闭。日志仍显示注入的原始源码位置，临时解包目录已清理。

五个工作区 native 包已恢复 debug 构建；目录包保留 release 裁剪产物。实施期间 Agent 未冷启动 Electron、未覆盖已安装应用、未正式发布。用户随后在确认使用打包模式后反馈“粗略测试下来正常”，作为最新目录包的人工粗测结果；未据此认定所有交互、语言回退或正式发布链路均已验收。正式签名、公证及 Sparkle 更新留待发布时验证。当前构建约定见 [macOS 打包与更新](../../../desktop/docs/macos-release.md)。

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

代码混淆不采用：用户确认项目本身开源，无需通过混淆保护源码；此次仅调研了按业务模块筛选的可行性，没有接入混淆工具。后续单独授权的常规 minify 已实施，结果见上述章节。

## 后续工作

- 五个 `.node` 仍分别链接了部分共用 Rust 实现；本次没有调整原生模块边界。后续若继续优化，先量化重复机器码及体积收益，再评估合并 addon 或共享动态库对模块职责、加载、签名和发布的影响。
- 纯 JS 的 ESM／CJS、其他环境构建与内部包副本已由 bundler 的实际依赖图取代，不再维护按 SDK 目录删除的后续工作；新增运行时文件资源必须有明确用途和路径。
- Rust LTO 暂缓，用户已明确先不处理；原定评估为对比 `thin`／完整 LTO 的体积、构建时间与功能回归，收益尚未测量。
- SwiftShader 暂保留，用户决定本轮不裁剪。当前目录包的 `libvk_swiftshader.dylib` 为 16,625,408 bytes（15.855 MiB），保留软件图形回退能力；后续若重新评估，先明确 GPU 不可用时的兼容性要求。
- 新正式版本仍需 Developer ID 签名／公证、安装及 Sparkle 更新验收；本地 ad-hoc 目录包不能替代。
