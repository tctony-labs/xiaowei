# macOS 打包与自动更新

## Why

桌面当前只有 electron-builder 目录包入口，没有安装包发布流水线和自动更新实现。用户于 2026-10-12 要求创建新分支推进 macOS 打包与自动更新，并确认创建本事项记录。

## What

- 首期仅支持 Apple Silicon（arm64），通过 GitHub Releases 分发。
- 补齐原生 addon release 构建、DMG 安装包、更新产物、签名与公证接线，以及版本一致性校验。
- 正式包后台检查更新，关于页复用现有检查更新入口；开发态不执行更新。
- 验收需区分自动测试、包内原生模块加载、签名／公证及已安装应用升级；未执行的验收不能视为完成。

## How

用户明确选择 Sparkle 标准原生更新窗口，保留 `com.tctony.xiaowei`，首期仅支持 arm64、GitHub Releases 和完整 ZIP／DMG，不扩展 delta 或多渠道。已对照旧版启动检查、原生交互、安装前退出及配置行为；分发源按用户选择从旧版 COS 改为 GitHub Releases。

使用固定 SHA-256 的官方 Sparkle 2.10.0，通过现有平台模块桥接，不引入额外更新框架。原生层持有 controller、delegate 与安装 continuation，TS main 负责检查策略、日志、业务关闭及 Dock 可见状态。保留原生 UI 是主要取舍：评估的 electron-sparkle-updater 使用 silent user driver，不满足交互要求。

正式发布使用个人 Developer ID 与独立长期 Sparkle Ed25519 密钥，不自动选择本机公司证书。完整发布采用单次 DMG 公证，再分别给 DMG 与同一份 App 附加票据，最后制作 ZIP；避免重复提交和各阶段重新构建产物。用户取消了更新重启后自动打开设置窗口和显示 toast 的方案，继续采用普通后台启动行为。

当前维护入口：

- [macOS 发布与更新说明](../../../desktop/docs/macos-release.md)：打包、版本、签名／公证、密钥、发布流程、更新行为和验收步骤。
- [xw-platform](../../../crates/xw-platform/README.md) 与 [xiaowei-platform](../../../crates/xiaowei-platform/README.md)：原生与 napi 边界。
- [main 模块说明](../../../desktop/src/main/README.md)：更新 service、关闭协调和 Dock 状态接入。

## Outcome

### 归档范围与最终结果

用户明确要求归档本事项。以已经交付的打包、正式发布与自动更新建设作为本次收尾范围，不再基于本 record 进行重大改动；此前 Plan 中尚未执行的独立验证项拆出为下述后续验证边界。长期说明已经落在现有包文档，实施 Plan 删除，后续常规修复更新代码与长期说明，不再追加本记录。

- v0.1.1 已正式发布并设为 latest；真实 CI、Developer ID 签名、单次 DMG 公证及两份票据验证通过。最终公开 feed、DMG、ZIP 可下载，附件版本、arm64、Sparkle 公钥、签名和完整性均已核验。
- 用户已明确确认从正式 0.1.0 成功更新到 0.1.1。这补齐了公开 GitHub 更新链路的实际升级结果；不据此声称所有数据保留场景或离线安装已验证。
- 后续 workflow 已移除 draft，所有前置检查成功后直接发布稳定 Release 并设为 latest；此项不修改已发布的 v0.1.1 tag 或附件。旧 0.1.0 草稿保留。
- Sparkle 原生窗口已通过现有 Rust → napi → TS 回调接入 Dock 可见状态。16 项更新 service／Dock 测试、3 项平台测试、原生构建、`just check` 与 diff 检查通过；没有保留重启后自动开窗、toast 或完成标记。
- 原生构建规则已收紧到实际受 API、实现路径、ABI、共享初始化或构建行为影响的 napi 包，不再仅因依赖同一 crate 扩大重建范围。

独立后续验证边界：DMG 离线安装运行、新 Dock 行为在下一份正式包中的实际窗口验证，以及未单独覆盖的正式升级数据保留场景。后续 workflow 的自动正式发布需下一次 tag 运行验证。这些项目未在本次归档中宣称通过，也不启动新的应用实例或发布新版本；需要继续验证时按独立任务开展。

以下保留各实施阶段的历史结果；其中“待验收”“未发布”等描述只对应当时阶段，最终结果及未验证边界以上文为准。

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

准备发布时，远程 v0.1.1 tag 尚不存在，v0.1.0 Release 为草稿，旧 run 38254060941 已成功。发布提交 65409b3 与新 v0.1.1 tag 已推送，CI 38258295087 全部通过。只提交一次 DMG 公证，submission=5b2c85e3-a7c8-4f6c-8679-c03342648439；DMG 与外部同一份 app 的票据和 Gatekeeper 校验均通过。经下载最终附件复核后，按用户授权正式发布并设为 latest；公开 feed、DMG 和 ZIP 下载地址均返回 HTTP 200，公开 feed 与核验过的签名内容一致。DMG 离线安装与用户启动的正式升级验收仍需另行完成，不因发布成功自动归档事项。


本轮独立阶段实际耗时：生产原生模块 6m29s，检查与 desktop 测试 4m54s，app 打包签名 1m51s，DMG 制作签名 39s，单次公证与两份票据／Gatekeeper 校验 1m29s，ZIP 制作 24s，appcast 生成验证 11s。正式 Release 为 https://github.com/tctony-labs/xiaowei/releases/tag/v0.1.1 。最终产物已核验，未由 Agent 启动 Electron 或执行升级安装；运行验收边界保持如上。


### 后续版本自动正式发布

用户要求去掉 workflow 中的 draft。发布命令已从 `--draft` 改为 `--latest`，job 与 step 名称同步调整；后续 tag 构建在测试、签名、公证、票据和 appcast 校验全部成功后直接发布稳定 Release，公开 latest feed 随之生效。发布流程说明同步明确：确认正式发布后推送 tag，没有草稿转正式的人工步骤。本次仅调整后续 workflow，不修改已发布 v0.1.1 的 tag 或产物；已有 0.1.0 草稿保留。
