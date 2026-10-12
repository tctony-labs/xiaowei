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

本地默认 ad-hoc，不自动选择现有 Tencent 证书。用户已确认使用个人签名身份，并要求参考本机 cmux。正式入口已复用 cmux 的 tctony-labs org 凭据名称，以完整 Developer ID 证书名和 APPLE_TEAM_ID 选择 distribution 身份，使用 Apple ID app-specific password 公证，避免回退到开发证书。CI 从已有 Sparkle 私钥推导并验证公钥，不需要新增 API key 或 org 公钥变量。Sparkle 可用 ad-hoc 与 Ed25519 更新，但 Gatekeeper 的对外分发验收需正式凭据。

## Current work

- 前两阶段本地打包与更新联调已完成；用户已要求继续第三阶段。按 [正式发布实施计划](../../plans/2026-10-12-macos-packaging-update/02-signed-release.md) 准备正式签名、公证与 GitHub Release 流水线。
- 发布输入预检查、Team ID／Developer ID／hardened runtime 校验、app／DMG 公证与票据／Gatekeeper 校验入口、Release 草稿 workflow 已实现。尚未运行实际签名或 CI，不以静态检查代替正式包验收。
- 个人身份已确认；已安装 cmux 的公开签名为 Developer ID Application: Chang Tang (NSWMLDGCEZ)。本机没有可用的该 Developer ID 私钥，正式构建使用 org 的现有 .p12，不自动使用本机公司证书。
- 已提交 14cfe99 并推送分支及 v0.1.0 tag。首次 CI 确认 Apple ID、Team ID、证书名、证书 .p12／密码、公证密码均可见，但 SPARKLE_PRIVATE_KEY 为空，预检查失败，尚未进入编译／签名／公证。当前 GitHub token 无权读取或调整 org secrets 元数据（403）；已请求用户授权该 secret 对 xiaowei 可见或配置同名仓库 secret，随后可重跑同一 CI，无需移动 tag。正式发布与升级验收尚待完成；事项未归档。
- 第三阶段必要验收：实际签名、公证、Gatekeeper、正式包两版本更新与 GitHub 下载链路；不能用既有 ad-hoc 测试包或私钥已丢弃的临时更新密钥替代。

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
