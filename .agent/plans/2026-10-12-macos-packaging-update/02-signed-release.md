# 正式签名、公证与 GitHub Release 准备

用户已要求继续第三阶段；本地打包和更新联调结果见 [record](../../records/active/2026-10-12-macos-packaging-update.md)。用户已确认个人身份，并指定参考本机 cmux；已对齐其现有 org 配置。

## 范围与前置条件

- 使用 GitHub Releases、仅 arm64、Sparkle 标准原生 UI、稳定 `x.y.z`／`v<version>`、完整 ZIP 和 DMG。
- 正式包要求显式 Developer ID Application 与预期 Team ID，Apple ID app-specific password 公证凭据，以及长期 Ed25519 更新密钥；不能复用本地测试密钥。不得自动使用本机公司证书。
- 流水线核对版本、构建／测试、签名与公证、验证包内模块和 Sparkle helper、生成签名 feed，并创建 Release 草稿；正式发布由维护者在最终验收后执行。
- 用户已授权提交、推送本分支，并创建 v0.1.0 tag 触发 CI；正式发布仍由维护者确认。org 凭据对本仓库的可见性待 CI 核对，真实正式包验收目前尚未执行。

## 文件与接口

| 文件 | 类型 | 本切片改动 |
| --- | --- | --- |
| `desktop/electron-builder.mac.cjs` | 修改 | 按完整证书名的持有人／Team ID 选择 distribution 身份、禁止开发证书回退，DMG 显式签名 |
| `scripts/release/package-mac.mjs` | 修改 | signed 模式要求 Team ID；核对主 app、五个 addon、Electron／Sparkle 代码签名身份与 hardened runtime；完整发布只提交 DMG 公证一次，分别给 DMG 与同一份 app 附加票据，最后制作 ZIP；CI 阶段独立计时 |
| `scripts/release/signing.mjs` | 新增 | 解析 codesign 验证结果、明确校验 Developer ID／Team ID／runtime，构建前校验必需凭据 |
| `.github/workflows/macos-release.yml` | 新增 | 稳定 tag／手动触发，macOS arm64，locked 安装、工作区检查和 desktop／原生测试、正式构建、appcast、artifact 和 Release 草稿 |
| `scripts/release/sparkle_generate_keys.sh` | 新增 | 显式使用官方工具与独立 xiaowei Keychain account 生成／导出私钥至指定 /tmp 文件，验证配对、拒绝覆盖，备份和配置由用户完成 |
| `scripts/release/check-release.mjs` | 新增 | 版本／tag、公钥／私钥配对、Team ID 和发布输入预检查；不输出凭据 |
| `scripts/tests/macos-release.test.mjs` | 修改 | 签名验证、版本／身份／缺失凭据与配对错误回归，使用临时密钥不访问个人 Keychain |
| `desktop/docs/macos-release.md` | 修改 | 凭据名称、签名／公证入口、CI 流程与正式包两版本验收步骤；区分已验证与未执行结果 |
| `.agent/records/active/2026-10-12-macos-packaging-update.md` | 修改 | 记录第三阶段确认、准备结果、已确认身份、org 配置映射与验收边界 |

不新增包或依赖，不改变 Rust／Gateway／renderer，不修改根 `docs/`。更新说明与自定义窗口布局不扩展为本切片实现需求。

## 实施顺序与验收

1. 发布输入预检查：tag 必须匹配版本，Ed25519 私钥与公钥配对，必需凭据缺失／非法 Team ID 失败；定向运行真实密码学回归。生产私钥只经 stdin 交给官方工具。
2. signed 包校验：构建后 strict codesign、预期 Developer ID／Team ID、hardened runtime、公证票据、Gatekeeper、包内 addon／framework／helper 校验，避免本地 ad-hoc 测试掩盖正式库校验问题。自动测试解析真实格式与拒绝错误身份；实际签名／公证使用 cmux 现有 org 配置，要在 CI 核对凭据可见性。
3. workflow 与文档：与现有 Actions 风格和构建入口对齐，先验证配置／版本，再安装依赖和运行检查，构建签名包，生成／验证 appcast，上传三种发布产物并创建草稿。静态 actionlint 和项目检查通过后，准备结果可审查。
4. 正式运行：个人身份已确认，源码提交／推送及 tag 后运行真实 CI，核对现有 org 凭据的可见性。用户冷启动正式旧版，再用同一长期公钥的新版走真实下载、签名／公证、安装重启和数据保留；通过后发布草稿。

前三步能独立完成实现准备；第 4 步是正式发布验收，未执行时保留事项 active，不报告第三阶段全部完成。本 Plan 覆盖实现与必要正式验收，结果持续回填 record／文档；正式验收完成后删除，未完成验收与外部动作列入 Current work。

## 当前结果

发布预检查、签名与公证校验、workflow 和文档准备已实现；八项 tooling、实际 ad-hoc 拒绝校验、actionlint 和完整 just check 通过。已复用 cmux 的 org 证书／Apple ID／Sparkle 配置，兼容省略 Base64 padding 并由私钥推导公钥。已安装 cmux 的公开签名验证了个人 Team ID NSWMLDGCEZ。首次 v0.1.0 CI 已运行，Apple 签名／公证配置均可见，但 SPARKLE_PRIVATE_KEY 为空，预检查失败。已按用户要求单独生成并导出小微密钥，用户确认添加 secret 后重跑原 CI，attempt 2 配置预检查与五个原生模块构建通过，但 contracts:check 因 runner 缺少 Go 而失败。已补齐与现有测试 workflow 一致的 Go 安装步骤，用户确认后已提交 4ed3793 并更新 tag，新的 run 38237430177 检查／测试通过，原生 release 编译异常慢。隔离复现定位到 jieba-rs 词典宏生成的巨大 Vec 初始化触发 LLVM SLP 向量化高耗时；静态数组后 to_vec 的等价临时实验冷 release 构建与两组分词校验共 11.90 秒。用户选择先等待当前 CI，后要求停止；run 38237430177 已取消，未生成产物或草稿。用户已授权两项修复；fork 已更新至 70a1d962，发布一次 release 产物复用已实现，相关本地分词／FTS、fixture 隔离、release 集成及 build:false 目录包验证已通过，结果已回填 record；实际签名／公证／正式升级仍待执行。本 Plan 保留，直到本切片必要的正式验证完成或用户明确收窄范围。

## 单次公证调整

用户确认先记录通用笔记，再将重复公证改为单次 DMG 提交。完整发布顺序为 app 签名、DMG 制作与签名、DMG 公证并给 DMG／app 附加票据、最终 ZIP 制作；每段独立 Actions step。electron-builder 自动公证关闭，DMG 公证后不再重建。目录包入口没有 DMG，保留通过临时 ZIP 对 app 提交一次公证的行为。具体实现及验收证据持续回填 record；真实 Apple 单次提交、DMG 离线安装及正式 ZIP 更新仍须 CI 与用户启动验收。
