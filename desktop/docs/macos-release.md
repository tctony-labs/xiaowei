# macOS arm64 打包与更新

桌面使用 electron-builder 打包，Sparkle 2.10.0 提供原生检查、下载、安装与重启界面。首期仅支持 Apple Silicon 和稳定的 `x.y.z` 版本，通过公开仓库 `tctony-labs/xiaowei` 的 GitHub Releases 分发。版本来源是 `desktop/package.json`，Release tag 必须为 `v<version>`；发布下一版本前递增该版本，保持 Sparkle 的升级比较单调递增。

发布包通过 `mac.electronLanguages` 仅保留简体中文（`zh_CN`）和英文（`en`）的 Electron 语言资源；本地更新测试包继承相同设置。`CFBundleLocalizations` 声明应用支持的语言，不承担资源裁剪。

发布文件过滤器排除所有 `*.map`，包括生产依赖自带的 source map；本地更新测试包沿用此规则。构建目录中的调试资料不因此删除，但不进入分发 ASAR。

仅在 renderer 使用、由 Vite bundled 的 React、React DOM、React Markdown、remark-gfm 和 zustand 声明为 `devDependencies`，打包时不再携带独立的生产依赖副本。main／LLM worker 的外部依赖和五个原生包继续作为生产依赖保留；构建回归检查 renderer 确实包含所需 React 与 Markdown 实现。

## 本地打包

准备工作区依赖、固定的 Node／pnpm／Rust 工具链和 Xcode Command Line Tools，在 Apple Silicon Mac 上执行：

```sh
pnpm --dir desktop package:mac
```

环境中必须提供 `SPARKLE_ED_PUBLIC_KEY`，值为正式更新密钥的 32 字节 Ed25519 公钥的 Base64。公钥进入主应用 `Info.plist`；它不是私钥。不要用临时测试公钥分发正式应用，否则后续正式密钥签名的更新无法安装。

此入口先下载 SHA-256 固定的官方 Sparkle 归档至忽略的 `desktop/.sparkle/`，再顺序构建五个正式 Rust napi 的 release 产物、desktop main／preload／renderer，最后生成：

- `desktop/dist/mac-arm64/XiaoWei.app`
- `desktop/dist/XiaoWei-<version>-arm64.dmg`
- `desktop/dist/XiaoWei-<version>-arm64.zip`

默认采用 ad-hoc 签名，不自动选用本机 Developer ID；不公证、不上传，也不启动应用。Sparkle 支持 ad-hoc 应用通过 Ed25519 验证更新，但这不等于应用已获得 Gatekeeper 的对外分发认可。`--dir` 仅生成应用目录，仍执行相同的原生 release 构建和签名流程：

```sh
pnpm --dir desktop package:mac --dir
```

带 `--signed` 时要求显式提供 Developer ID Application 的 `CSC_LINK`（Base64 `.p12`）、`CSC_KEY_PASSWORD`、完整证书名 `CSC_NAME`，以及 `APPLE_ID`、十位 `APPLE_TEAM_ID` 和 app-specific password `APPLE_APP_SPECIFIC_PASSWORD`。证书名必须为 `Developer ID Application: <姓名> (<Team ID>)`，并与 Team ID 一致。builder 使用证书持有人与 Team ID 选择 distribution 身份，禁止回退到开发证书；打包后再次验证身份和 hardened runtime。缺少配置直接失败。

```sh
pnpm --dir desktop package:mac --signed
```

正式完整打包只向 Apple 提交最终 DMG 公证一次。顺序为：打包并签名 app → 从同一份 app 制作并签名 DMG → 提交 DMG 公证 → 分别给 DMG 和工作目录中的 app 附加票据并验证 → 用已附加票据的 app 制作 ZIP。Apple 会处理 DMG 内的签名代码并生成对应票据；工作目录中的 app 与 DMG 内的 app 签名身份相同，因此可以取得其票据。electron-builder 自动公证已关闭，DMG 公证后不再重新打包或签名，ZIP 使用 ditto 在票据附加之后生成。依据见 [Apple 公证工作流](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。

核对主 app、Electron／Sparkle framework、Sparkle helper／XPC 和五个 napi 的 Team ID、Developer ID 与 hardened runtime，同时检查 app／DMG 的票据和 Gatekeeper。stapler 返回 CloudKit 错误 68 时，按 5、10、20 秒间隔最多重试三次；其他错误或重试耗尽仍阻止发布，不重复提交公证。单独执行 ZIP 阶段也必须通过 app 票据与 Gatekeeper 校验。`--signed --dir` 不生成 DMG，因此只通过临时 ZIP 提交 app 公证一次并附加票据，临时 ZIP 随后删除。

DMG 内的 app 在制包时尚未单独附加票据，DMG 分发携带外层票据；更新 ZIP 中的 app 携带自身票据。正式验收需分别覆盖 DMG 离线安装运行与 ZIP／Sparkle 更新，不能只凭本地 ad-hoc 打包或在线 stapler 校验认定离线体验已通过。

原有 `pnpm --dir desktop package` 保留为通用开发目录包入口，不携带 Sparkle；验收更新必须使用 `package:mac` 的产物。

## 本地两版本更新联调

先执行以下入口，一次生成同一套临时 Ed25519 密钥签名的两个测试版本：

```sh
pnpm --dir desktop package:mac:test
pnpm --dir desktop update:mac:serve
```

不需要 Developer ID、公证或手工配置更新密钥。密钥仅驻留构建进程，经 stdin 交给官方签名工具，不写入文件或个人 Keychain；构建结束后不保留私钥。当前 package 版本作为旧版，patch 加一作为新版，不修改仓库 package.json。五个 addon 与 desktop 源码只构建一次，两个包复用同一份 release 产物，只有打包版本不同。

测试包名为 `XiaoWei Local Update`，appId 为 `com.tctony.xiaowei.local-update`，feed 固定为 `http://127.0.0.1:18765/appcast.xml`。数据、日志、Agent 和模型配置位于 `~/Library/Application Support/com.tctony.xiaowei.local-update/`；忽略正式 Agent／模型路径环境覆盖，不读取现有正式数据。HTTP 的 ATS 本地网络配置只进入测试包。测试包的全局快捷键仍可能与开发实例冲突，测试前由用户正常退出开发实例。

产物保存在忽略的 `desktop/dist/local-update/` 中：每个版本包含 `mac-arm64/XiaoWei Local Update.app`、DMG 和 ZIP；`installed/` 保存可直接启动、允许 Sparkle 替换的旧版副本；`source/` 保存新版 ZIP 和签名 feed；`test.json` 记录版本、公钥、产物路径，不含私钥。已有成功测试对时再次准备会拒绝覆盖；需要重做时先将此目录移到别处，重新生成的包和 feed 必须成对使用。

本地服务仅监听 127.0.0.1，只提供当前 feed／ZIP，记录请求和状态码；它不会启动 Electron。可以 Ctrl-C 停止，默认 `valid` 为正常更新；以下两种模式分别提供篡改后的 feed 或 ZIP，用来检查 Sparkle 拒绝无效签名：

```sh
pnpm --dir desktop update:mac:serve invalid-feed
pnpm --dir desktop update:mac:serve invalid-archive
```

测试 feed 当前未填更新说明，Sparkle 标准窗口会隐藏说明区域，显示紧凑且不可缩放的提示。提供非空 appcast description 或 release notes 地址后，原生窗口会启用说明区域并允许调整大小；无须修改框架。

### 人工联调步骤

1. 保持正常更新源运行。由用户启动 `desktop/dist/local-update/installed/XiaoWei Local Update.app` 旧版副本；也可以打开旧版 DMG，把应用拖至可写的 Applications 目录后再启动。不要直接在 DMG 只读卷中更新，也不要先安装新版。
2. 在关于页确认旧版本，创建可识别的测试设置、剪贴板条目或 Agent 会话；可选记录数据目录内文件内容以便比较。
3. 点击检查更新，核对原生 Sparkle 窗口识别新版。先取消下载／安装，确认仍可使用旧版；再关闭服务检查网络失败，恢复服务后继续。
4. 使用两个篡改模式确认错误能被显示和记录、没有安装新版。每次切换先停止前一个服务；检查前先关闭上一轮 Sparkle 窗口。测试结束恢复正常服务。
5. 正常下载并选择安装，确认日志先记录 `prepare-install` 与业务关闭，再由 Sparkle 替换、重启；关于页变成新版，原测试数据仍在，同一版本检查不再提示升级。
6. Agent 核对打包应用进程、独立日志和服务下载请求，记录实际结果。普通 Node 加载 addon 不替代此 Electron 运行验证。

第 1 步必须由用户执行，Agent 不冷启动应用。当前本地联调只验证 ad-hoc 包的更新机制；正式签名／公证包和 GitHub 下载链路需要在后续阶段再做最终升级验收。

## 更新密钥与 appcast

Sparkle 的 Ed25519 更新签名密钥与 Apple 代码签名证书是两套独立凭据。小微使用独立的长期更新密钥，在 xiaowei 仓库配置 Actions secret `SPARKLE_PRIVATE_KEY`。CI 从私钥推导公钥，并通过真实签名／验签确认配对；发布流水线不会自动生成或替换密钥。私钥不得进入仓库、日志或长期开发记录。

首次生成或重新导出现有密钥时，显式执行：

```sh
scripts/release/sparkle_generate_keys.sh
```

脚本参考 cmux，使用已固定的官方 Sparkle 2.10.0 `generate_keys`，在登录 Keychain 的 `xiaowei` account 中生成或读取密钥，再导出到 `/tmp/xiaowei-sparkle-private-key.txt`（权限 `0600`）。导出前验证公私钥配对，只输出公钥和文件路径；目标文件已存在时拒绝覆盖。由发布者备份该文件，并把文件中的 Base64 私钥作为 xiaowei 仓库 secret `SPARKLE_PRIVATE_KEY` 的值；无需添加公钥变量。完成备份和配置后由发布者移除临时导出文件。

完成 DMG／ZIP 打包后，在环境中提供 `SPARKLE_ED_PRIVATE_KEY`（官方导出的 Base64 私钥种子或兼容格式），生成 appcast：

```sh
node scripts/release/generate-appcast.mjs v0.1.0
```

参数必须匹配当前 `desktop/package.json`。工具只处理本版本的 ZIP，以 stdin 将私钥交给官方 `generate_appcast`，不从个人 Keychain 隐式读取凭据；生成后使用官方 `sign_update --verify` 验证 feed 签名，并使用构建公钥验证 ZIP 的 Ed25519 签名、长度、版本和对应 tag 的下载地址。本期只发布完整更新 ZIP，不生成 delta，也不保留多个版本的 appcast 条目。

应用要求签名 feed 和更新包。固定 feed 为 `https://github.com/tctony-labs/xiaowei/releases/latest/download/appcast.xml`，条目中的下载地址指向对应 `v<version>` Release 的 ZIP。GitHub 的 latest 下载地址只在 Release 正式发布后更新；草稿和 prerelease 不进入这条稳定 feed。发布时同时携带 DMG、ZIP 和 `appcast.xml`。

## GitHub Release 准备

[macOS release workflow](../../.github/workflows/macos-release.yml) 支持推送稳定 `v*` tag 或手动输入已有 tag。它核对版本、tag 指向、公私钥配对和显式签名配置，安装 locked 依赖，顺序构建一次五个生产 napi release addon，再通过 `scripts/release/test-prebuilt.mjs` 执行工作区检查、tooling、平台和 desktop 测试。desktop 测试生成的 main／preload／renderer 与这些生产 addon 一起供打包复用；发布脚本以 `packageMac({signed:true, build:false, stage})` 按以下四个独立 Actions step 执行，不重复编译：

1. `app`：生成目录包、签名并验证 app。
2. `dmg`：通过 electron-builder 的 `--prepackaged` 复用 app，仅制作并签名 DMG。
3. `notarize`：只提交 DMG，等待 Accepted，然后分别附加并校验 DMG 与 app 票据和 Gatekeeper。
4. `zip`：重新校验 app 票据后，用 ditto 制作最终更新 ZIP，不重建 DMG。

每个 step 独立显示耗时，前一步失败会阻止后续发布。随后生成验证 appcast，上传 Actions artifact，并直接发布稳定 GitHub Release、设为 latest；公开更新源随之生效。本地一键入口不指定 stage 时按相同顺序执行；ad-hoc 模式跳过公证。

发布测试先在独立 `target/rust-napi-tests/search` 目录构建启用 gateway-fixtures 的 Search 测试模块，成功后才向平台／desktop 测试子进程设置已有的 `XIAOWEI_TEST_NAPI_PREPARED=1`。消费测试跳过生产 debug 重建，仍执行原有测试列表和生产接口检查。发布入口在测试前后核对五个生产 `.node` 的 SHA-256；构建 fixture 或测试失败、生产文件缺失或发生变化均阻止打包。测试 fixture 使用 debug profile，不进入应用。普通 `test.yml → just test` 保持原有 debug 构建及 fixture 准备流程，本地 `package:mac` 默认仍自行构建 release。

各版本发布构建串行执行。参考本机 `~/Develop/Projects/cmux/.github/workflows/build-tctony.yml`，复用 tctony-labs org 的个人 Developer ID 和 Apple ID 公证配置，Sparkle 更新私钥单独配置在 xiaowei 仓库，不需要新增 App Store Connect API key。证书由 electron-builder 导入构建用临时 Keychain；Apple ID 密码只注入签名／公证步骤，Sparkle 私钥只在预检查／appcast 步骤注入，经 stdin 交给官方工具。流水线不自动创建或替换长期更新密钥。

用户已确认使用个人身份。已安装 cmux 的公开签名元数据显示 `Developer ID Application: Chang Tang (NSWMLDGCEZ)`；CI 仍以 org 配置为输入并校验其一致性。配置名称与 cmux 一致；Apple 配置来自 org，Sparkle 私钥由小微单独生成并配置在仓库：

| 配置类型 | 配置名称 | 本地脚本环境变量与用途 |
| --- | --- | --- |
| Variable | `APPLE_ID` | `APPLE_ID`：公证 Apple ID |
| Variable | `APPLE_TEAM_ID` | `APPLE_TEAM_ID`：Developer Team ID |
| Variable | `MACOS_APPLICATION_CERT_NAME` | `CSC_NAME`：完整 Developer ID Application 证书名 |
| Secret | `MACOS_APPLICATION_CERT_P12` | `CSC_LINK`：包含证书及私钥的 Base64 `.p12` |
| Secret | `MACOS_APPLICATION_CERT_P12_PASS` | `CSC_KEY_PASSWORD`：`.p12` 密码 |
| Secret | `APPLE_ID_PASS` | `APPLE_APP_SPECIFIC_PASSWORD`：Apple ID app-specific password |
| Repository Secret | `SPARKLE_PRIVATE_KEY` | `SPARKLE_ED_PRIVATE_KEY`：官方更新私钥，支持 32 字节 seed 和旧版 96 字节导出，也兼容省略 Base64 padding |

CI 推导 `SPARKLE_ED_PUBLIC_KEY`，验证公私钥配对后只将公钥写入后续步骤的环境。无需单独配置 org 公钥变量。正式打包前也可本地执行 `node scripts/release/check-release.mjs v<version>`；本地需提供表中对应环境变量和 `SPARKLE_ED_PUBLIC_KEY`。此入口以无敏感内容的 challenge 做真实签名／验签，确认公私钥配对后才构建，不输出私钥、不操作个人 Keychain。

org 设置查询曾受到 GitHub token 权限限制（403）。小微使用独立 Sparkle 更新密钥，由用户备份并配置 `SPARKLE_PRIVATE_KEY`；v0.1.1 的真实 CI 已验证必需凭据可见性及正式签名、公证。流水线预检查会对缺失值直接报错，CI 必须使用已提交的版本源码。该次建设的验收结果见 [归档记录](../../.agent/records/archived/2026-10-12-macos-packaging-update.md)。私钥、证书与密码不要粘贴到聊天或提交到仓库。

### 发布新版本

应用版本只维护在 `desktop/package.json`。例如发布 `0.1.1`，将其 `version` 从 `0.1.0` 改为 `0.1.1`，对应 tag 为 `v0.1.1`。关于页通过 `app.getVersion()` 显示该版本；打包流程由它生成 `CFBundleShortVersionString`、`CFBundleVersion`、DMG／ZIP 文件名及 Sparkle 更新版本。内部 workspace npm 包与 Rust crate 不需要随应用发布同步递增版本。只打新 tag 而不改应用版本会被 CI 预检查拒绝。

每次发布按以下顺序执行：

1. 确定高于当前已分发版本的稳定 `x.y.z` 版本，修改 `desktop/package.json`，整理该版本的改动说明。继续使用原有 Developer ID 身份与长期 Sparkle 更新密钥。
2. 完成相关回归和 `just check`，确认待发布代码、版本和必要文档均已提交，工作区没有遗漏的发布改动。
3. 决定正式发布时，推送发布提交，再在同一提交上创建并推送 `v<version>` annotated tag。tag 推送会触发 macOS release workflow，校验成功后自动正式发布；CI 检出 tag 指向的提交，并核对 tag、应用版本与 HEAD 一致。已发布版本的 tag 和附件不覆盖；修正已分发版本时递增版本重新发布。
4. 等待 CI 完成构建／测试、app 签名、DMG 制作、单次公证及两份票据校验、最终 ZIP 与 appcast 签名验证。核对 run 的 head SHA 与发布 tag 一致，所有发布阶段成功。
5. CI 在所有前置阶段成功后直接发布稳定 Release、设为 latest，并生成 Release notes。推送 tag 是本次正式发布的触发点，后续没有草稿转正式的人工步骤。
6. 核对已发布 Release 包含本版本的 `XiaoWei-<version>-arm64.dmg`、`XiaoWei-<version>-arm64.zip` 和 `appcast.xml`，检查版本、签名身份、公证、更新下载地址及 Release notes。用户运行验收按下节执行，未完成的项目明确保留为待验收。
7. 发布后通过未登录下载地址验证 DMG、ZIP 和 `releases/latest/download/appcast.xml`；确认 latest feed 的版本、ZIP 下载地址、长度与签名匹配最终产物。由用户启动已安装旧版，通过检查更新完成安装、重启及数据保留验收。

以 `0.1.1` 为例，在版本改动已提交且相关检查通过后，触发构建的命令为：

```sh
git push origin HEAD
git tag -a v0.1.1 -m "XiaoWei v0.1.1"
git push origin refs/tags/v0.1.1
```

网络等临时故障可以重跑相同提交的 CI；需要修改源码时，新提交不会自动进入旧 tag 的构建。尚未分发的 tag 如需调整，先确认没有并发构建或已发布产物，再按用户授权更新；已公开分发的版本使用新版本号。

### 正式包最终验收

1. 核对现有 org 设置对 xiaowei 仓库的可见性；CI 使用已确认的个人 Developer ID、Apple ID 公证和长期更新密钥重新构建，不能上传本地测试包或复用其 feed。
2. 源码提交／推送与 tag 后运行真实 CI，检查签名主体、公证 Accepted、app／DMG 票据和 Gatekeeper；所有前置阶段成功后自动正式发布。
3. 使用同一长期公钥、同一已确认 Developer ID 的两个递增正式版本。由用户启动已安装旧版，复验原生窗口、取消／失败、安装前业务关闭、重启、版本、数据保留和无新 crash。正式发布前的受控 feed 联调不能代替公开更新链路验收。
4. 发布后通过 GitHub 正式下载地址核对 feed／ZIP 与重定向，再验证正式更新链路。历史草稿附件不属于公开更新源。

上述步骤用于各版本的正式验收。v0.1.1 已完成签名、公证、附件核验，用户已确认从正式 0.1.0 成功升级；DMG 离线安装、新 Dock 行为的正式包验证和其他未覆盖场景见归档记录中的后续验证边界。

## 运行与验收

main 持有更新 service，正式 macOS 包启动后执行后台检查，Sparkle 按一周间隔检查；自动下载关闭，用户在原生窗口决定下载和安装。关于页使用已确认的按钮，通过 `System.CheckForUpdates` 触发交互式检查。开发态隐藏按钮且不初始化 Sparkle；不支持的平台或未携带正确配置的包不会提供有效更新能力。

Sparkle 原生更新 UI 通过标准 user driver delegate 的生命周期事件接入 Dock 可见状态。即使设置窗口已关闭，只要更新提示、检查或下载／安装 UI 仍处于会话中，Dock 图标保持可见；原生 UI 结束后，按其余普通窗口决定显隐。更新重启沿用普通后台启动行为。

原生安装 delegate 延期安装，向 main 投递 `prepare-install`；main 等待 Gateway、Agent／LLM、剪贴板与 Storage 等业务关闭，再恢复 Sparkle 的安装 continuation。正常退出复用同一次关闭 Promise，controller 在 `will-quit` 释放。更新初始化、检查、发现版本、错误和安装准备写入既有桌面日志。

```mermaid
sequenceDiagram
    participant UI as 关于页
    participant Main as Electron main
    participant Sparkle
    participant GH as GitHub Releases
    UI->>Main: System.CheckForUpdates
    Main->>Sparkle: 交互式检查
    Sparkle->>GH: 下载并验证签名 appcast
    Sparkle->>Sparkle: 原生窗口确认下载与安装
    Sparkle->>GH: 下载并验证 ZIP
    Sparkle->>Main: prepare-install（延期安装）
    Main->>Main: 关闭 Gateway 与后台业务
    Main->>Sparkle: resumeInstall
    Sparkle->>Sparkle: 安装并重新启动应用
```

自动回归覆盖 Gateway 调用、开发态禁用、原生桥接失败、并发检查、安装前等待关闭、关闭后的迟到事件，以及关于页成功／失败交互。构建和 appcast 验签不能代替已安装应用升级验收：需要用同一长期公钥打包两个递增版本，在真实 Electron 中检查原生窗口、取消／网络失败、下载、安装前退出、版本升级与用户数据保留。Agent 不自行冷启动桌面；应用启动与实例操作仍遵循根 AGENTS.md。
