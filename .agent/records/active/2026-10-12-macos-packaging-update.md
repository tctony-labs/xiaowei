# macOS 打包与自动更新

## Why

桌面当前只有 electron-builder 目录包入口，没有安装包发布流水线和自动更新实现。用户于 2026-10-12 要求创建新分支推进 macOS 打包与自动更新，并确认创建本事项记录。

## What

- 首期仅支持 Apple Silicon（arm64），通过 GitHub Releases 分发。
- 补齐原生 addon release 构建、DMG 安装包、更新产物、签名与公证接线，以及版本一致性校验。
- 正式包后台检查更新，关于页复用现有检查更新入口；开发态不执行更新。
- 验收需区分自动测试、包内原生模块加载、签名／公证及已安装应用升级；未执行的验收不能视为完成。

## How

当前工作分支为 `feat_macos_packaging_update`，通过 Git Flow 从 `develop` 创建。发布仓库现有 origin 为 `tctony-labs/xiaowei`，通过 `gh repo view` 确认是公开仓库，可供未登录客户端下载 release。

已核对旧版 `/Users/changtang/Develop/XiaoWei/workspace/src/xiaowei-next` 的 `xiaowei/src-tauri/src/biz/update.rs`、启动初始化、`Info.plist` 与关于页：更新由外层 host 持有，使用 Sparkle 的交互式检查与整包替换，debug 隐藏入口，启动后台检查，定期检查间隔为一周，关闭自动安装，安装前处理退出相关工作。旧版上传至 COS，产物带渠道及流水线构建号。

用户明确选择继续使用 Sparkle，保留原生交互式更新窗口，不采用 electron-updater／Squirrel.Mac。现有 appId 保持 `com.tctony.xiaowei`。

使用官方 Sparkle 2.10.0（固定上游归档 SHA-256），通过现有 `xw-platform`／`xiaowei-platform` 提供动态框架桥接；平台层持有 controller、delegate 与安装 continuation，TS main 持有检查策略、日志和退出协调。旧版插件只作为接口／行为参考，不依赖 Tauri。现成 `electron-sparkle-updater@0.5.3` 采用 silent user driver，关闭原生窗口并自动下载，不符合本次体验，未引入。

发布入口、更新行为、密钥配置和人工验收要求统一维护在 [macOS 发布](../../../desktop/docs/macos-release.md)。稳定 `x.y.z` 版本与 `v<version>` tag 对齐；首期仅完整 ZIP，不做 delta／多渠道。feed 和更新包均采用 Ed25519 验签，本地打包与更新联调已通过；第三阶段 GitHub Release 草稿流水线已实现，实际正式签名与分发验收仍待执行。

本地更新联调使用专用测试包身份 `com.tctony.xiaowei.local-update` 和 loopback HTTP feed，两个版本共用一次构建的 release 原生模块及一套临时 Ed25519 密钥。所有业务数据、Agent 与模型目录隔离于独立测试根；私钥只驻留构建进程，公钥和产物信息进入忽略的本地 manifest。正式包不包含本地 HTTP 的 ATS 配置。Sparkle 2.10.0 要求签名 feed 同时开启解包前验签，打包配置和包内验证均已补齐此项。

本地默认 ad-hoc，不自动选择现有 Tencent 证书。用户已确认使用个人签名身份，并要求参考本机 cmux。正式入口已复用 cmux 的 tctony-labs org 凭据名称，以完整 Developer ID 证书名和 APPLE_TEAM_ID 选择 distribution 身份，使用 Apple ID app-specific password 公证，避免回退到开发证书。CI 从 Sparkle 私钥推导并验证公钥，不需要新增 API key 或 org 公钥变量。首次 CI 缺少更新私钥后，用户要求参考 cmux 单独生成小微密钥，并由用户备份与配置仓库 secret；生成方式见发布文档。Sparkle 可用 ad-hoc 与 Ed25519 更新，但 Gatekeeper 的对外分发验收需正式凭据。

## Current work

- 前两阶段本地打包与更新联调已完成；用户已要求继续第三阶段。按 [正式发布实施计划](../../plans/2026-10-12-macos-packaging-update/02-signed-release.md) 准备正式签名、公证与 GitHub Release 流水线。
- 发布输入预检查、Team ID／Developer ID／hardened runtime 校验、app／DMG 公证与票据／Gatekeeper 校验入口、Release 草稿 workflow 已实现。CI 已完成 app 签名与公证，app 票据校验被 Apple 网络中断阻塞；当前失败原因与修复见下，不以静态检查代替完整正式包验收。
- 个人身份已确认；已安装 cmux 的公开签名为 Developer ID Application: Chang Tang (NSWMLDGCEZ)。本机没有可用的该 Developer ID 私钥，正式构建使用 org 的现有 .p12，不自动使用本机公司证书。
- 已提交 14cfe99 并推送分支及 v0.1.0 tag。首次 CI 确认 Apple ID、Team ID、证书名、证书 .p12／密码、公证密码均可见，但 SPARKLE_PRIVATE_KEY 为空，预检查失败，尚未进入编译／签名／公证。当前 GitHub token 无权读取或调整 org secrets 元数据（403）；已按用户要求生成小微独立密钥并导出至 /tmp/xiaowei-sparkle-private-key.txt。用户确认已添加 secret，现已重跑同一 CI（attempt 2），原 run attempt 2 的 Go 缺失已修复，用户确认后提交 4ed3793 并更新 v0.1.0 tag。[新 run 38237430177](https://github.com/tctony-labs/xiaowei/actions/runs/38237430177) 的配置、Go、五个 debug napi、检查与全部 desktop 测试均通过；正式 release 构建耗时异常，用户要求后于 19:27 取消，状态 completed／cancelled；尚未进入签名／公证，没有产物或 Release 草稿。正式发布与升级验收尚待完成；事项未归档。
- 编译阻塞的两项修复已实现并完成相关本地验收：jieba fork dev 已提交 70a1d962，小微固定新 rev，发布流程一次 release 构建供测试与打包复用。用户现已授权提交／推送小微修复，并将 v0.1.0 从 4ed3793 更新到本次修复，触发新的 CI。
- 第三阶段必要验收：后续提交修复后运行正式 CI，验证实际签名、公证、Gatekeeper、正式包两版本更新与 GitHub 下载链路；不能用既有 ad-hoc 测试包或私钥已丢弃的临时更新密钥替代。

## Outcome

### 本地打包与自动验证

- `just gen`、完整 `just check`、生成一致性、最终 Biome 和 diff whitespace 检查通过；仅保留未改动 Select 组件的既有 info。
- 五个正式 napi 的 release 构建通过，平台三个回归通过，覆盖缺失配置、非主线程访问和焦点资源接口。原生变更后重新构建受影响 addon。
- 初始 desktop 全量测试通过：41 项基础、56 项 main、66 项 LLM、138 项 renderer 及原生联调；新增测试数据隔离后 main 57 项通过，发布 tooling 六项通过，覆盖配置隔离、实际密码学验证与本地 HTTP 正常／篡改响应。
- 通过 `package:mac:test` 生成 `0.1.0 → 0.1.1` 的 arm64 ad-hoc DMG／ZIP，不修改仓库版本；两个包复用一次构建的 release addon 和 desktop 源码，使用同一套临时 Ed25519 密钥。私钥只驻留构建进程，经 stdin 交给官方工具，构建结束不保留。
- 严格 codesign、appId／版本／feed／公钥／Sparkle 策略、五个 addon 的架构／系统动态依赖／普通 Node 加载检查通过。ASAR 包含五个 addon、LLM worker 和正确 package metadata；升级后五个 `.node` 与修复后的新版产物 SHA-256 一致，安装后的严格签名校验通过。
- 官方工具与公钥验证签名 feed、ZIP 的版本／长度／下载地址均通过。真实 HTTP 下载的正常产物验证成功，篡改 feed／ZIP 被拒绝；服务只监听 loopback。
- 修复前测试对保留在忽略的 `desktop/dist/local-update-before-close-fix/`，修复后测试对位于 `desktop/dist/local-update/`。这些包使用临时更新公钥，不用于公开分发。

### 真实 Electron 更新联调

由用户冷启动测试包，Agent 通过原生窗口、独立日志、进程、包内元数据和 DiagnosticReports 核对结果：

- 正式打包态下原生模块、LLM worker、renderer、Sparkle 初始化正常；启动后台检查显示原生更新窗口，关于页通过 typed System.CheckForUpdates 触发交互式检查。取消更新提示后仍可使用旧版。
- 断开本地源时显示网络错误；篡改 feed 显示签名验证错误；篡改 ZIP 下载后显示真实性验证错误。失败场景没有安装新版，恢复正常源后可以重新检查和更新。
- 首轮更新虽然安装并重启到 `0.1.1`，旧进程退出时发生 crash，验收判为失败。报告明确指向原生 Drop 中不存在的 `setDelegate:` 调用；Sparkle 通过 weak delegate 管理，不提供 setter。修复为 controller → delegate → bundle 的 Retained 自然释放，并将官方 SUNoUpdateError（1001）视为正常无更新结果。
- 修复后重新构建测试对，用户于 `14:17:49` 启动旧版。`14:17:57.356` 收到 prepare-install，等待业务关闭、剪贴板监控停止、旧应用停止；`14:17:57.736` Sparkle 自动启动 `0.1.1`，原生模块与 worker 等重新初始化正常。安装路径版本为 `0.1.1`，升级后进程 PID 为 74619；再次手动检查更新只记录 update-not-available，不再误报失败。
- 账号配置、主题和 auth 文件与升级前基线哈希一致。两条既有剪贴板记录的持久内容、分类等字段保留：仅回退当前行的 last_used_at 和 use_count 就可匹配原整行哈希，证明变化仅为正常活跃元数据。未单独构造 Agent 会话，不声称覆盖所有业务数据场景。
- 用户于 `14:22:15` 按 ⌘Q 普通退出，日志记录剪贴板监控停止和 Application stopping，PID 已消失。修复后的升级退出与普通退出均没有新增 crash report；现存两份报告均来自修复前 `14:03:29` 和 `14:06:53` 的错误清理代码。
- 原生 UI 自动控制在升级后曾持续 timeout，最后普通退出由用户完成；该工具超时不作为应用崩溃证据。所有结果由实际进程、日志与报告交叉验证。

本地更新联调与退出崩溃复验通过，已回填结果并删除本切片 Plan。临时本地源服务已停止，测试包和独立测试数据保留。

### 分发与界面边界

没有执行正式 Apple 签名／公证，没有创建或发布 GitHub Release。前两阶段结束时删除的 workflow 草稿已在第三阶段重新实现为待运行的正式发布流程，个人身份和现有 org 配置名称已对齐 cmux，但尚未执行 CI 验证凭据可见性与实际产物。

当前测试 feed 未包含 description 或 release notes 地址，Sparkle 因此隐藏说明区域、采用不可缩放的紧凑窗口。官方 SUUpdateAlert.m 显示：提供非空说明或 release notes 地址后会启用说明区域并允许调整窗口大小；这不需要修改 Sparkle 窗口实现。用户询问了此行为，目前没有新增自定义 UI 或版本说明生成需求。

### 第三阶段实现准备

- `check-release.mjs` 验证稳定 tag／版本、显式签名配置、长期更新公私钥配对；以官方 sign_update 对无敏感内容的 challenge 做真实签名／公钥验证，支持 32 字节 seed、旧版 96 字节导出及省略 Base64 padding。私钥只走 stdin，不写入文件或访问个人 Keychain。
- 正式 builder 以 CSC_NAME 的持有人／团队限定名选择 distribution 身份，并预先核对 APPLE_TEAM_ID，不自动选择现有公司证书或回退开发证书。打包后核对 app、五个 addon、Electron／Sparkle framework、Sparkle Autoupdate／Updater／XPC 的 Developer ID、Team ID 和 hardened runtime。DMG 也做 Developer ID 签名、单独提交 Apple 公证、Accepted 校验、staple、票据与 Gatekeeper 检查；源码确认 builder 本身只公证 app，因此补充 DMG 流程。
- macOS arm64 release workflow 支持稳定 tag／手动已有 tag，执行预检查、locked 安装、原生与 desktop 测试、正式构建、appcast 验签、artifact 和 Release 草稿。采用 cmux 现有 org 名称：APPLE_ID、APPLE_TEAM_ID、MACOS_APPLICATION_CERT_NAME、MACOS_APPLICATION_CERT_P12、MACOS_APPLICATION_CERT_P12_PASS、APPLE_ID_PASS 和 SPARKLE_PRIVATE_KEY。只在需要的步骤注入凭据，更新私钥走 stdin，公钥由私钥推导并验证；没有读取个人 secrets 文件、配置远程 secrets 或触发 workflow。
- 发布 tooling 八项回归通过，包括错误 Team／开发或 ad-hoc 签名／缺失 runtime、配置缺失、签名身份选择、真实新旧格式更新密钥配对和不匹配拒绝。实际本地 ad-hoc 包被正式签名验证拒绝。
- actionlint 1.7.7 通过；完整 just check、Biome 和 diff whitespace 检查通过。以已安装 cmux 的实际 codesign 元数据运行本项目正式验证器，Developer ID／Team ID NSWMLDGCEZ／hardened runtime 校验通过，未修改或启动 cmux。实际小微 Developer ID／公证／CI／正式升级仍未执行。

第三阶段修改后重跑实际本地目录打包入口：release 构建、desktop 构建、distribution 模式 ad-hoc 签名、包内配置与五个 arm64 addon 加载／系统动态依赖检查通过，未启动应用。此目录包继续使用测试公钥，不作为正式分发产物。

### 首次正式 CI

用户已授权提交、推送并触发 0.1.0 打包。提交 `14cfe99` 与 tag `v0.1.0` 已推送至 origin，工作分支仍为 `feat_macos_packaging_update`，未合并 develop。

[Actions run 38218192990](https://github.com/tctony-labs/xiaowei/actions/runs/38218192990) 在配置预检查失败：Apple 签名／公证输入均非空，org 的个人身份与 Team ID 符合预期；映射的 `SPARKLE_PRIVATE_KEY` 未传入，报错 `SPARKLE_ED_PRIVATE_KEY is required`。尚未编译、生成产物或创建 Release。需补齐该 secret 的仓库可见性或同名仓库配置后重跑当前 run；未自动创建／替换更新密钥。

### 小微独立更新密钥

用户要求参考 cmux 的 sparkle_generate_keys.sh，私钥导出到 `/tmp/xiaowei-sparkle-private-key.txt`，备份与 GitHub secret 配置由用户完成。已新增 `scripts/release/sparkle_generate_keys.sh`，复用固定的官方 Sparkle 2.10.0 工具，使用登录 Keychain 独立 account `xiaowei`。实际生成／导出成功，私钥文件权限 0600，真实官方工具签名与公钥验签通过；拒绝覆盖已有文件的检查通过。私钥未输出到日志或写入仓库，备份和远程 secret 由用户完成；用户确认添加后已由 Agent 重跑原 CI。

### 第二次 CI 与 Go 工具链修复

用户确认添加私钥后重跑原 run（attempt 2）。配置预检查通过，推导公钥与本地生成结果一致；工具链、locked 依赖安装及五个 napi debug 构建通过。`pnpm check` 的 contracts:check 在首次安装 protoc-gen-go 时报告 `spawnSync go ENOENT`：发布 workflow 缺少现有测试 workflow 的 Go 安装步骤。已复用 `scripts/ci/go-cache.mjs version` 与 actions/setup-go，静态 actionlint 通过。尚未生成正式包，需提交该修复并将 v0.1.0 更新到新提交后触发新构建；旧 run 重跑不会应用本地修复。

### Release 编译耗时定位

新 run 的原生 release 输出长期停在 Storage，但 Cargo 会并行编译依赖，最后一行不能代表唯一活跃 crate。Agent 在独立 `/tmp/xiaowei-ci-storage-probe` target 目录冷构建复现，确认活跃 rustc 是 `jieba_rs`，opt-level=3，持续约单核 100% CPU。进程采样集中于 LLVM SLPVectorizer 的 store-chain 调度。当前 fork 的 yada_dict 宏把 349045 行词典的词频生成为巨大的 vec! 初始化。

仅在 `/tmp/xiaowei-jieba-macro-probe` 的源码副本将频次生成为静态 usize 数组，再 to_vec，保持 opt-level=3 与原有词典内容。临时 jieba 验证工程的完整独立冷 release 构建及两组中文分词校验用时 11.90 秒（不代表小微完整打包耗时）；原写法的本地进程仍在长时间优化，采样后已停止该临时诊断进程。可审查差异保存于 `/tmp/xiaowei-jieba-static-frequencies.patch`。实验时尚未修改或推送 fork，也未改变小微依赖 rev／打包流程；后续 CI 取消及正式修复见下。

生产模块测试可加载 release addon，原流水线先 debug 后 release 是沿用测试准备入口的选择。已将生产 release 构建、测试和打包复用一次产物，测试 fixture 单独构建；词典宏修复涉及另一个仓库。用户最初选择等待、随后取消 CI；现已确认分别修复 fork 和发布产物复用，并授权直接修改远程 fork。

### 用户取消当前 CI

用户先要求等待当前打包，随后要求停止本轮 CI。已取消 [run 38237430177](https://github.com/tctony-labs/xiaowei/actions/runs/38237430177)，GitHub 确认 status=completed、conclusion=cancelled。日志在 19:27:17 报告 The operation was canceled；release 阶段的 Agent（1m29s）、Platform（56.36s）、Search（42.88s）已完成，Storage 及其 jieba-rs 依赖未返回完成输出。最后一条编译输出是 18:49:15，直到取消仍未继续。上传产物与 Release 草稿步骤均 skipped，artifact 数量为 0。

取消时 tag 指向 4ed3793，未生成产物；后续修复与验证见下，正式签名／公证／升级验收仍待后续工作。

### 词典宏修复与 release 复用

用户确认分别修复两项，并授权直接修改远程 jieba fork。远程 dev 已通过 GitHub Contents API 更新为 [70a1d962](https://github.com/tctony/jieba-rs/commit/70a1d9623e2713345aa708089766ba606342d8d8)，仅改 yada-macros/src/lib.rs：局部静态频次数组后 to_vec，保留词典、类型及 release 优化等级。临时完整 fork 副本的默认 Yada release 单测 14 项与 doctest 3 项通过；额外关键词 feature 与现有 Yada 实现不兼容，不改变当前 feature。小微已固定新 rev，Cargo 更新锁文件仅替换三个同仓库包的 source。

发布 workflow 已改为先构建一次生产 release addon，通过发布专用 test-prebuilt.mjs 准备独立 Search fixture 后设置已有 prepared 变量，再复用生产模块和 desktop 测试构建输出打包。测试前后五个 .node SHA-256 必须一致；测试或完整性检查失败阻止打包。长期说明见 [macOS 发布说明](../../../desktop/docs/macos-release.md#github-release-准备)。普通 test workflow、root／desktop 测试 runner 及共享 fixture helper 未修改。本地验证结果如下；小微改动尚未提交，不变更 tag 或重启已取消的 CI。

- 用户指出本次只需相关测试后，不继续全量 just test。中断前 Rust workspace 测试已完成，其中 xw-tokenizer 6 项、Storage 23 项（含 4 项 clipboard_search 和逐连接／重开 FTS 注册）均通过；五个生产 debug napi 与隔离 fixture 构建通过。pnpm 工作区全量测试中途终止，不宣称 just test 全量通过。普通测试 workflow、root／desktop runner 与共享 fixture helper 的 diff 均为空。
- 五个生产 release napi 顺序构建成功；Storage 增量 release 为 10.45 秒、Clipboard 为 7.56 秒。这是已有本地缓存条件下的构建时间，不代表 CI 冷构建或完整打包耗时。
- 实际 release 验证使用 testPrebuilt 的真实 fixture／哈希逻辑，仅将测试执行器收窄为相关入口：发布／复用／fixture tooling 19 项、平台 3 项、Storage napi 1 项、desktop Storage／生产业务边界 5 项均通过。Search fixture 输出到独立目录；四个 Gateway 生产模块接口检查通过；五个生产 .node SHA-256 在测试前后相同。未重跑完整 desktop 测试列表，发布 CI 保留原有列表。
- 同一 release 产物通过 packageMac({build:false, directoryOnly:true}) 生成本地 ad-hoc 应用，strict codesign、版本／更新元数据、arm64／系统依赖和包内五个 addon 加载均通过；打包前后工作区原生产物 SHA-256 与测试后快照一致。生成目录为 desktop/dist/mac-arm64/XiaoWei.app；未生成新的 DMG／ZIP，未启动 Electron。日志保存于 /tmp/xiaowei-fixes-prebuilt-package.log。
- just check、actionlint、针对新增脚本的 Biome、diff 空白与显示宽度检查通过。仅 fork 已远程提交；小微修复、记录和发布说明保持未提交。正式 Developer ID／公证／GitHub 下载与升级验收仍由 02 Plan 承载。

### 修复提交与 CI 重启授权

用户明确要求提交、推送 tag 并重新触发 CI。本次提交包含 fork 固定 rev／锁文件、release 复用入口与回归、workflow 及对应说明和已有进展记录。保持 0.1.0 版本；更新既有 v0.1.0 tag，推送时核对远程旧 tag，避免覆盖并发修改。当前没有 v0.1.0 Release 草稿或已发布产物。后续核对新 run 的 head SHA、编译／签名／公证与产物；正式发布和正式升级仍待验收。

### Apple 票据校验网络重试

[run 38247984788](https://github.com/tctony-labs/xiaowei/actions/runs/38247984788) 对应提交 9ac4744，生产 release 构建和测试通过，app 签名、公证及包内五个原生模块加载成功。随后 `stapler validate` 访问 Apple CloudKit 票据服务时出现 NSURLErrorDomain -1005（连接中断），退出 68；app Gatekeeper、DMG 公证、产物上传与 Release 草稿尚未执行。

用户要求修复、提交并更新 v0.1.0 tag 重新触发。发布脚本为 app 票据校验及 DMG staple／validate 增加仅针对退出码 68 的有限退避重试，行为详见发布文档；不绕过校验或重复提交公证。回归先复现旧实现收到 68 立即失败，再确认恢复后才执行 Gatekeeper、持续失败最多四次、其他错误与进程启动失败不重试、成功无需等待；发布与产物复用测试共 18 项通过。真实 Apple 网络交互仍待新 CI 验证，事项保持 active。

### 单次 DMG 公证与阶段耗时

用户先要求拆分 Actions 阶段以查看耗时，随后要求优先消除 app 与 DMG 的两次公证提交，并确认先记录通用笔记再改代码。笔记已保存至 `~/notes/tools/macos-single-notarization.md`。核对 Apple 官方文档后确认：公证顶层 DMG 会同时处理嵌套 App，票据按已签名内容关联；同一份 App 的工作目录原件可以获取对应票据，无需再提交一次。

正式完整发布已改为四个可独立运行的阶段：app 打包签名 → DMG 制作签名 → 只提交 DMG 并给 DMG／app 分别附加、验证票据 → 制作最终 ZIP。electron-builder 自动公证关闭；DMG 从 `--prepackaged` app 制作，公证后不重建；ZIP 在 app 票据校验之后由 ditto 生成。原生构建和 desktop 测试构建产物继续复用。`--signed --dir` 没有 DMG，保留通过临时 ZIP 提交 app 公证一次的行为。原有限重试继续用于票据操作，不重试公证提交。

27 项相关回归、完整 just check、actionlint 和最终 Biome／diff／显示宽度检查通过。验证覆盖完整 packageMac 入口与 workflow 各阶段，确认只有一次 DMG 提交、两个目标各自附加票据、拒绝公证或 app 票据失败时不生成 ZIP，以及单独 ZIP 阶段不依赖签名私钥或 Apple 密码。实际本地 ad-hoc App／DMG／ZIP 分阶段打包通过；整个 App 文件树在后续制包中保持一致，ZIP 制作前后 DMG SHA-256 相同，解压 ZIP 的 App 与源目录文件树一致且 strict codesign 通过，DMG hdiutil 校验通过，官方 Sparkle 工具对最终 ZIP 生成并验证签名 appcast 成功。临时测试包 0.1.901 和临时密钥已清理，未启动 Electron。

首次本地打包遇到已有 Platform 二进制缺少 SparkleUpdater 导出，按既有入口重新构建该 napi release 后验证通过；未修改 Rust 源码。真实 Developer ID 单次提交及两个票据的服务端匹配仍待新 CI；DMG 离线安装运行和正式 ZIP／Sparkle 更新仍需用户启动验收。用户已要求提交本次修改；未推送或更新 tag，事项及正式发布 Plan 保持 active。

### 0.1.1 发布

用户要求明确后续版本发布流程，并授权发布 v0.1.1。已在 macOS 发布说明中补齐版本来源、提交与 tag、CI 草稿核验、正式发布和公开更新源验证的顺序；desktop/package.json 升为 0.1.1，内部 workspace 包及 Rust crate 版本保持各自生命周期。此次发布包含已提交的单次 DMG 公证与独立阶段计时修复。

远程 v0.1.1 tag 尚不存在，v0.1.0 Release 为草稿，旧 run 38254060941 已成功。待推送本次发布提交与新 tag，核对 CI 签名／单次公证、票据与最终产物后正式发布 0.1.1，并检查公开 latest feed。DMG 离线安装与用户启动的正式升级验收仍需另行完成，不因发布成功自动归档事项。
