# 正式签名、公证与 GitHub Release 准备

用户已要求继续第三阶段；本地打包和更新联调结果见 [record](../../records/active/2026-10-12-macos-packaging-update.md)。用户已确认个人身份，并指定参考本机 cmux；已对齐其现有 org 配置。

## 范围与前置条件

- 使用 GitHub Releases、仅 arm64、Sparkle 标准原生 UI、稳定 `x.y.z`／`v<version>`、完整 ZIP 和 DMG。
- 正式包要求显式 Developer ID Application 与预期 Team ID，Apple ID app-specific password 公证凭据，以及长期 Ed25519 更新密钥；不能复用本地测试密钥。不得自动使用本机公司证书。
- 流水线核对版本、构建／测试、签名与公证、验证包内模块和 Sparkle helper、生成签名 feed，全部前置校验成功后直接发布稳定 Release 并设为 latest。
- 用户已授权提交、推送本分支并发布 v0.1.1；CI、签名、公证及最终附件验证通过，已正式发布。真实旧版更新及 DMG 离线安装仍待用户运行验收。

## 文件与接口

| 文件 | 类型 | 本切片改动 |
| --- | --- | --- |
| `desktop/electron-builder.mac.cjs` | 修改 | 按完整证书名的持有人／Team ID 选择 distribution 身份、禁止开发证书回退，DMG 显式签名 |
| `scripts/release/package-mac.mjs` | 修改 | signed 模式要求 Team ID；核对主 app、五个 addon、Electron／Sparkle 代码签名身份与 hardened runtime；完整发布只提交 DMG 公证一次，分别给 DMG 与同一份 app 附加票据，最后制作 ZIP；CI 阶段独立计时 |
| `scripts/release/signing.mjs` | 新增 | 解析 codesign 验证结果、明确校验 Developer ID／Team ID／runtime，构建前校验必需凭据 |
| `.github/workflows/macos-release.yml` | 新增 | 稳定 tag／手动触发，macOS arm64，locked 安装、工作区检查和 desktop／原生测试、正式构建、appcast、artifact 和稳定 Release 自动发布 |
| `scripts/release/sparkle_generate_keys.sh` | 新增 | 显式使用官方工具与独立 xiaowei Keychain account 生成／导出私钥至指定 /tmp 文件，验证配对、拒绝覆盖，备份和配置由用户完成 |
| `scripts/release/check-release.mjs` | 新增 | 版本／tag、公钥／私钥配对、Team ID 和发布输入预检查；不输出凭据 |
| `scripts/tests/macos-release.test.mjs` | 修改 | 签名验证、版本／身份／缺失凭据与配对错误回归，使用临时密钥不访问个人 Keychain |
| `desktop/docs/macos-release.md` | 修改 | 凭据名称、签名／公证入口、CI 流程与正式包两版本验收步骤；区分已验证与未执行结果 |
| `.agent/records/active/2026-10-12-macos-packaging-update.md` | 修改 | 记录第三阶段确认、准备结果、已确认身份、org 配置映射与验收边界 |

不新增包或依赖，不改变 Rust／Gateway／renderer，不修改根 `docs/`。更新说明与自定义窗口布局不扩展为本切片实现需求。

## 实施顺序与验收

1. 发布输入预检查：tag 必须匹配版本，Ed25519 私钥与公钥配对，必需凭据缺失／非法 Team ID 失败；定向运行真实密码学回归。生产私钥只经 stdin 交给官方工具。
2. signed 包校验：构建后 strict codesign、预期 Developer ID／Team ID、hardened runtime、公证票据、Gatekeeper、包内 addon／framework／helper 校验，避免本地 ad-hoc 测试掩盖正式库校验问题。自动测试解析真实格式与拒绝错误身份；实际签名／公证使用 cmux 现有 org 配置，要在 CI 核对凭据可见性。
3. workflow 与文档：与现有 Actions 风格和构建入口对齐，先验证配置／版本，再安装依赖和运行检查，构建签名包，生成／验证 appcast，上传三种发布产物并直接发布稳定 Release、设为 latest。静态 actionlint 和项目检查通过后，准备结果可审查。
4. 正式运行：个人身份已确认，源码提交／推送及 tag 后运行真实 CI，核对现有 org 凭据的可见性。用户冷启动正式旧版，再用同一长期公钥的新版走真实下载、签名／公证、安装重启和数据保留；CI 全部前置校验成功后自动正式发布，运行验收仍单独记录。

前三步能独立完成实现准备；第 4 步是正式发布验收，未执行时保留事项 active，不报告第三阶段全部完成。本 Plan 覆盖实现与必要正式验收，结果持续回填 record／文档；正式验收完成后删除，未完成验收与外部动作列入 Current work。

## 当前结果

发布提交 65409b3 与 v0.1.1 tag 已推送，CI 38258295087 全部通过，单次 DMG 公证成功并获取 DMG 与外部 app 的两份票据。下载最终附件的签名、arm64、版本、公钥一致性、Gatekeeper、票据、DMG 完整性和 Sparkle feed／ZIP 签名检查均通过。用户已授权正式发布，v0.1.1 已发布并设为 latest；未登录公开 feed 与附件地址均返回 HTTP 200。

当前仍需由用户启动已安装 0.1.0，验证通过正式 feed 下载 0.1.1、安装前业务关闭、重启、版本和数据保留，并完成 DMG 离线安装运行。本 Plan 保留至这些必要运行验收完成或用户明确收窄范围；不以成功发布代替升级验收。

## 单次公证调整

用户确认先记录通用笔记，再将重复公证改为单次 DMG 提交。完整发布顺序为 app 签名、DMG 制作与签名、DMG 公证并给 DMG／app 附加票据、最终 ZIP 制作；每段独立 Actions step。electron-builder 自动公证关闭，DMG 公证后不再重建。目录包入口没有 DMG，保留通过临时 ZIP 对 app 提交一次公证的行为。具体实现及验收证据持续回填 record；真实 Apple 单次提交与两份票据验证已通过 CI 和最终附件复核；DMG 离线安装及正式 ZIP 更新仍须用户启动验收。
