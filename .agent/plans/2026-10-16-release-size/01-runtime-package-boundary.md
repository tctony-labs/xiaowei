# 从构建源头控制桌面分发边界

## 范围与目标

纯 JS／TS（工作区代码及第三方依赖）默认交给 Vite 构建到 `out/`；懒加载目标生成相邻 chunk。只有明确允许的五个 native 包作为运行时外部包，分发 `.node`、生成的 JS 加载器和必要 package 元数据。Electron 与 Node 内置模块由宿主提供，不复制进应用。

应用静态资源、Sparkle 等非 JS 资源沿用现有明确的 `extraResources`／`extraFiles` 入口；若发现依赖必须运行时读取文件，单独确认具体资源路径和用途，再声明资源，不恢复整个依赖目录复制。

保留语言筛选、source map 排除和 release `strip -x`。移除被新边界覆盖的逐 SDK／环境／源码／声明文件排除规则。保留既有业务、worker 隔离、Gateway 和 provider 行为，不合并 Rust 模块，不启用 LTO，不升级依赖，不修改根 docs 或 README。

## 已核实的实现条件

- `electron-vite` 5.0.0 默认把 `dependencies` 外置，当前 pi-ai、electron-log 等因此仍在运行时读取 `node_modules`。需显式关闭自动外置，使用 native 外部包白名单。
- 内存构建试验（`write: false`，未改源文件）证实纯 JS 可纳入 bundle。一般 provider 的静态 `import()` 会自然形成 chunk。
- Bedrock SDK lazy 入口刻意通过变量路径导入，不能原样留在 bundle。项目 `apis.ts` 改为复用公开 `lazyApi`，提供静态可分析的 `import("@earendil-works/pi-ai/api/bedrock-converse-stream")`，保持相同的延迟加载与 ProviderStreams 语义；不改第三方包、不改成启动时加载 AWS SDK。
- 原型中显式接入 Bedrock 后，main 输出 51 个 chunk、合计 4,123,781 bytes，包含独立 Bedrock chunk；原先的 Bedrock／OAuth 变量导入 helper 不再出现在输出中。可见外部 import 仅 Electron、五个 native 包和 Node 内置模块。该结果只证明构建可行，尚未代替运行和正式目录包验收，也不是最终体积。

## 文件与职责

| 文件 | 类型 | 具体改动 |
| --- | --- | --- |
| `desktop/electron.vite.config.ts` | 修改 | main／preload 关闭自动依赖外置；main 明确列出五个 native 外部包；保留宿主内置模块处理、source 条件和各构建入口。 |
| `desktop/src/main/services/llm/worker/apis.ts` | 修改 | 只替换 Bedrock 的变量路径 lazy 适配，使用 SDK 公开 lazyApi＋字面量动态导入；其他 provider 保持既有 API。 |
| `scripts/dev/desktop-source-resolution.test.mjs` | 修改 | 检查 main／preload／renderer 构建输出及模块图：内部包从源码 bundled，第三方纯 JS 不外置，允许的外部引用只有宿主与 native；发现未声明外部引用时失败。 |
| `desktop/tests/fixtures/llm.mjs` | 修改 | 为测试显式传入 worker URL，默认保留既有 out 路径，使同一套 fixture 可验收隔离分发产物。 |
| `desktop/tests/llm/bundled-worker.test.mjs` | 新增 | 在工作区外的临时目录中只复制构建输出与 type 元数据，验证没有纯 JS node_modules 时 provider chunk 加载、worker 启动、Gateway 调用、流式生成、失败、取消、关闭及 WebSocket 路径。 |
| `desktop/package.json` | 修改 | `dependencies` 只保留五个 native 包；pi-ai、electron-log、Gateway、contracts、protobuf 等构建输入移到 devDependencies，保留 workspace 源码消费。 |
| `pnpm-lock.yaml` | 修改（pnpm 生成） | 同步依赖分类，不升级已解析版本，不手改锁文件。 |
| `desktop/electron-builder.mac.cjs` | 修改 | 删除逐依赖裁剪名单，只保留通用 source map 排除、语言、签名及 Sparkle 配置；不删除或重写历史提交。 |
| `scripts/release/package-mac.mjs` | 修改 | 在既有包校验入口接入内容边界验证，未知运行包／源码目录／声明或 source map 混入时阻止发布；保留签名与 native 加载检查。 |
| `scripts/release/verify-package-content.mjs` | 新增 | 读取实际 ASAR 文件列表，确认只含 out、应用元数据及 native 允许文件；提供内容错误的具体相对路径；如隔离解包用于验收，确保临时目录清理。 |
| `scripts/tests/macos-release.test.mjs` 等发布回归 | 修改 | 补充合法分发内容与意外 JS 包／工作区源码等失败场景，保留原有签名、公证与分阶段发布断言。 |
| 根 `package.json` | 按需修改 | 若正式验证需要读取 ASAR，显式声明打包链已经使用的同版本 `@electron/asar` 为开发工具依赖，复用其公开 API，避免手写 ASAR 解析器或依赖未声明的传递包；不会进入分发。 |
| `desktop/docs/macos-release.md` | 修改 | 用构建边界、native 白名单和必要资源声明取代逐 SDK 文件删除说明，记录升级后的验证要求。 |
| `.agent/records/active/2026-10-16-release-size.md` | 修改 | 记录新决策、旧规则被替代的原因、实际产物体积、验证结果及尚未完成的 GUI／正式发布验收。 |

## 执行顺序与提交

### 1. 默认 bundle 与可分析的 Bedrock 懒加载

先补构建边界测试，确认旧配置因外置 pi-ai／electron-log 等而失败；再调整 main／preload 构建与 Bedrock 适配。暂不删除已安装依赖，避免把构建问题和收集问题混在一起。

验证：

- 所有纯 JS 实现来自构建 chunk，保留五个 native 外部入口及 Electron／Node builtins。
- Bedrock 有实际实现 chunk，调用时再加载；不能只检查 worker 空配置启动成功。
- 隔离目录无 SDK 或内部 JS 包，也能运行 worker 并完成本地 fixture 请求。
- 复用 `desktop/tests/llm/*.test.mjs` 与 main／日志相关测试，覆盖普通生成、流式事件、取消、错误和关闭；WebSocket 使用本地服务验证。
- 新增模块／依赖未知动态路径或非白名单外部引用必须显式暴露，不以构建成功代替运行验收。

完成此切片后单独提交并回填 record。

### 2. 收紧运行时依赖与分发内容，替换旧规则

纯 JS 包移到开发依赖，通过 pnpm 同步锁文件。删除 macOS 发布中的逐包过滤，改为对最终内容做白名单验收，确认只剩 native node_modules。构建生成的懒加载 chunk 属于 out，可正常随包分发。

验证：

- 工作区继续通过 source 条件消费 TS，不引入对工作区内部 dist 的业务依赖。
- native 包需要的 index.js、package.json、arm64 `.node` 均存在，未混入 Rust／TS 源码或其他生产包；后续新增 native 依赖需要同时通过边界检查。
- 真实 ad-hoc 目录包经现有入口的签名、版本、arm64 与五个 native 加载检查，并通过 ASAR 内容验收。
- 将真实包解包到工作区之外，只用其 out、native 与明确资源执行集成验收；不得回退加载工作区 node_modules。
- 对比当前基线 306,118,222 bytes（291.937 MiB），分别报告 ASAR、native 和应用整体实际体积，不使用内存原型推算作为结果。
- 发布回归、构建检查及各提交的 `just check` 通过。

完成此切片后单独提交并回填 record。

### 3. 文档与生命周期收尾

更新包内发布文档，记录动态加载、资源例外及依赖声明约束；在 record 标记旧排除规则被替代，保留历史测量的证据。删除本 Plan 和空目录；按用户要求单独提交完成的修改。

真实 Electron GUI、系统语言回退、Developer ID／公证与 Sparkle 正式更新仍由用户启动后验收，不冷启动、不覆盖已安装应用、不发布。未完成这些验收时 record 保留 active，不主动归档。
