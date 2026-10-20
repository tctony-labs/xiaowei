---
name: release-desktop-app
description: >-
  准备或发布 XiaoWei macOS App 时使用：维护版本及更新说明，推送 tag 触发发布，
  跟踪 CI 并验证安装包和自动更新。也覆盖本地打包与更新联调；创建技能或讨论方案不触发发布。
---

# 发布 XiaoWei 桌面 App

发布设计与实现见 [macOS 打包与更新](../../../desktop/docs/macos-packaging-and-updates.md)，实际入口为 [macOS release workflow](../../../.github/workflows/macos-release.yml) 和 `scripts/release/`。当前仅发布 macOS arm64 稳定版；服务器部署使用独立的 `depoly-server` 技能。

先明确用户要求的是准备发布、本地打包还是正式发布。正式发布前，先完成准备和检查，展示版本范围及整理后的更新说明，获得用户对这份具体发布内容的确认后才触发发布；同一份内容已确认时不重复询问。源码提交、推送和合并遵循根 [AGENTS.md](../../../AGENTS.md) 与会话授权；缺少提交授权时，在展示具体改动时一并请求提交授权。不要把仅准备文件或创建本技能解释为正式发布授权。

仅做本地打包、两版本更新联调、更新密钥准备、调试归档或体积核对时，读取 [本地打包与验证](references/local-validation.md) 对应章节。应用由用户冷启动，Agent 不启动 Electron 或覆盖已安装应用。

## 1. 准备版本与更新说明

1. 核对当前分支、未提交改动、远端已发布版本和用户指定的发布范围，确定本次源码提交及上一稳定版本。不要将工作区改动当作已经进入远端构建。
2. 选择高于已分发版本的稳定 `x.y.z`，只修改 `desktop/package.json` 的应用版本；内部 workspace npm 包和 Rust crate 不随之递增。对应 tag 为 `v<version>`，不能只打 tag 而不改应用版本。
3. 在 `desktop/releases/<version>.md` 维护本次更新说明。这是 GitHub Release 正文和 Sparkle 更新弹窗的唯一内容来源；不要另写两份正文，也不再依赖 GitHub `--generate-notes`。
4. 比较上一稳定版本到待发布提交的实际改动，整理面向用户的新增、优化、修复和必要的使用影响。可参考提交说明，但须核对实现；未实现、未进入发布提交或没有证据的功能不写入。仅保留有内容的分类，不用提交列表或 Full Changelog 链接代替具体说明。

说明第一行必须为 `# XiaoWei <version>`，正文使用 Markdown 标题、段落和列表。文件需包含实际更新内容；只有标题、空章节或注释会被校验拒绝。发布后保留该版本文件，后续版本另建文件，不重写已分发版本的说明。

确定 `release_version` 与 `release_tag` 后，在仓库根目录校验：

```sh
release_version=$(node -p "JSON.parse(require('fs').readFileSync('desktop/package.json')).version")
release_tag="v${release_version}"
node scripts/release/release-notes.mjs "$release_tag"
```

完成相关回归和 `just check`。核对待发布代码、版本、说明和必要文档均已准备齐全，没有遗漏的发布改动；获得提交授权后将它们纳入发布提交。

## 2. 核对发布配置

继续使用现有 Developer ID 身份与长期 Sparkle 更新密钥。配置名称、来源和环境变量映射见 [CI 配置](../../../desktop/docs/macos-packaging-and-updates.md#ci-配置)。核对这些配置对目标仓库可用，不读取或输出 secret 值，不为普通发布生成新密钥。

CI 会校验 tag 与应用版本、tag 提交与 HEAD、签名配置以及 Ed25519 公私钥配对。org 配置查询遇到权限不足时，明确区分“无法查询”和“配置缺失”；以实际 CI 预检查结果为准，不能用本地测试密钥绕过。

## 3. 触发并跟踪正式发布

tag 推送会自动正式发布稳定 Release 并设为 latest，没有草稿转正式的人工步骤。完成上述准备和检查后，向用户展示上一稳定版本／tag、本次目标版本与源码范围、完整更新说明和检查结果，等待用户确认再触发发布。若这些具体内容已在当前会话确认，沿用确认；确认后发布范围或说明发生实质变化时，重新展示变更并确认。手动触发 workflow dispatch 也遵循此确认点。

确认后执行已授权的源码推送、annotated tag 创建与推送。记录完整 `release_sha`，核对发布提交包含确认过的代码、版本和说明：

```sh
release_sha=$(git rev-parse HEAD)
git push origin HEAD
git tag -a "$release_tag" "$release_sha" -m "XiaoWei $release_tag"
git push origin "refs/tags/$release_tag"
```

已有 tag 时先核对其指向与发布状态，不直接覆盖。远端稳定 tag 已存在、尚无 Release 且需要手动触发时，可使用 workflow dispatch；先确认没有同版本正在运行的构建：

```sh
gh workflow run macos-release.yml --repo tctony-labs/xiaowei \
  --ref "$release_tag" -f tag="$release_tag"
```

根据 workflow、事件、tag、触发时间及提交 SHA 关联本次 run，不直接选“最近成功”的构建。可用以下命令查询，再确定 `run_id`：

```sh
gh run list --repo tctony-labs/xiaowei --workflow macos-release.yml \
  --commit "$release_sha" --json databaseId,event,headSha,status,conclusion,url
gh run view "$run_id" --repo tctony-labs/xiaowei --json headSha,status,conclusion,url
```

跟踪版本说明校验、配置预检查、构建与测试、app 签名、DMG 制作、公证和票据、ZIP、签名 appcast、附件上传及 Release 发布。保持进度反馈；run 成功必须对应本次 tag 的提交。具体阶段及产物复用机制见设计文档，不在技能中复制实现。

失败时先定位失败阶段。网络等临时故障可在确认原因后重跑同一提交的 CI；不要反复触发相同失败。源码修改不会自动进入旧 tag。尚未分发的 tag 需要调整时，先确认没有并发构建或公开产物，再按用户授权处理；已分发版本的 tag 和附件不覆盖，修复使用新版本号。

## 4. 发布核对与运行验收

1. 核对本次 Release 的 tag、提交、正式状态和 latest 状态；正文必须与 `desktop/releases/<version>.md` 一致，不能只有版本对比链接。
2. 核对四个附件：`XiaoWei-<version>-arm64.dmg`、`XiaoWei-<version>-arm64.zip`、`XiaoWei-<version>-arm64-debug-symbols.zip`、`appcast.xml`。检查 CI 签名身份、公证 Accepted、app／DMG 票据与 Gatekeeper 的结果；调试归档的 commit、模块 UUID 和校验值须对应本次构建。
3. 通过未登录的 GitHub 正式下载地址验证 DMG、ZIP 和 `releases/latest/download/appcast.xml`，检查重定向、版本、ZIP URL、长度和 Ed25519 签名。可复用 `scripts/release/sparkle.mjs` 的 `verifySignedAppcast` 与 `verifyUpdateArchive`，使用既有公钥；历史草稿附件不属于公开更新源。
4. 核对 feed 的 `description` 包含本次 Markdown 正文，`fullReleaseNotesLink` 指向 `https://github.com/tctony-labs/xiaowei/releases`。正文在生成 feed 时一起签名，不手工修改已签名 XML。
5. 由用户启动使用同一长期公钥、同一 Developer ID 的已安装旧版，检查新版本说明显示、取消／网络失败、下载、安装前业务关闭、重启、版本递增、数据保留及无新 crash。新版再次检查更新时，核对“版本历史记录”打开全部版本列表。受控 feed 联调不能代替公开更新链路验收。
6. 由用户验证正式 DMG 的离线安装运行；该验收与 ZIP／Sparkle 更新分别记录，不能只凭 ad-hoc 包、在线 stapler 或构建成功认定通过。

交付时报告版本、源码 SHA、CI run 和 Release 链接、更新说明及实际验证结果。技术发布完成与用户运行验收分别说明；尚未执行的项目列明待验收，不宣称已经通过。例行发布结果在对话中汇报，不为每次发布新建开发 record。
