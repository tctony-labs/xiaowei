---
name: release-desktop-app
description: >-
  准备或发布 XiaoWei macOS App 时使用：处理代码、版本和更新说明，合回 develop，
  确认发布范围后推送分支与 tag，触发 CI。创建技能或讨论方案不触发发布。
---

# 发布 XiaoWei 桌面 App

发布设计与实现见 [macOS 打包与更新](../../../desktop/docs/macos-packaging-and-updates.md)，实际入口为 [macOS release workflow](../../../.github/workflows/macos-release.yml) 和 `scripts/release/`。当前仅发布 macOS arm64 稳定版；服务器部署使用独立的 `depoly-server` 技能。

先明确用户要求的是准备发布、本地打包还是正式发布。正式发布先将当前分支合回 `develop`，再基于合并后的 `develop` 确定版本范围、整理更新说明并完成检查；展示这些具体内容并获得用户确认后，才推送分支和触发发布。同一份内容已确认时不重复询问。源码提交、推送和合并遵循根 [AGENTS.md](../../../AGENTS.md) 与会话授权；缺少提交授权时，先展示具体改动并请求提交授权，再继续合并。不要把仅准备文件或创建本技能解释为正式发布授权。

用户另行要求本地打包、两版本更新联调、更新密钥准备、调试归档或体积核对时，读取 [本地打包与验证](references/local-validation.md) 对应章节。应用由用户冷启动，Agent 不启动 Electron 或覆盖已安装应用。

## 1. 合回 develop 并准备版本与更新说明

1. 核对当前分支和未提交改动，按已有授权提交待合并内容，并同步远端 `develop` 的状态。
2. 将当前分支合回本地 `develop`；已在 `develop` 时无需另做分支合并。能快进时使用快进合并，存在分叉时保留双方提交并解决冲突。此时不推送分支，后续版本准备在 `develop` 上完成。
3. 核对远端已发布稳定版本，将上一稳定 tag 解析为提交 SHA，以它到合并后 `develop` 的差异确定发布范围；同时检查提交记录与最终 diff，避免遗漏 develop 已有改动或写入已回退的功能。不要用合并前工作分支的范围请求发布确认。
4. 选择高于已分发版本的稳定 `x.y.z`，只修改 `desktop/package.json` 的应用版本；内部 workspace npm 包和 Rust crate 不随之递增。对应 tag 为 `v<version>`，不能只打 tag 而不改应用版本。
5. 在 `desktop/release-notes/<version>.md` 维护本次更新说明。这是 GitHub Release 正文和 Sparkle 更新弹窗的唯一内容来源；不要另写两份正文，也不再依赖 GitHub `--generate-notes`。
6. 按实际改动整理面向用户的新增、优化、修复和必要的使用影响。可参考提交说明，但须核对实现；未实现、未进入发布提交或没有证据的功能不写入。仅保留有内容的分类，不用提交列表或 Full Changelog 链接代替具体说明。

说明第一行必须为 `# XiaoWei <version>`，正文使用 Markdown 标题、段落和列表。文件需包含实际更新内容；只有标题、空章节或注释会被校验拒绝。发布后保留该版本文件，后续版本另建文件，不重写已分发版本的说明。

确定 `release_version` 与 `release_tag` 后，在仓库根目录校验：

```sh
release_version=$(node -p "JSON.parse(require('fs').readFileSync('desktop/package.json')).version")
release_tag="v${release_version}"
node scripts/release/release-notes.mjs "$release_tag"
```

完成相关回归和 `just check`。核对待发布代码、版本、说明和必要文档均已准备齐全，没有遗漏的发布改动；按提交授权将它们纳入 `develop` 的发布提交，记录完整 `release_sha`。

## 2. 推送并触发 CI

tag 推送会自动正式发布稳定 Release 并设为 latest，没有草稿转正式的人工步骤。完成合并、准备和检查后，向用户展示上一稳定版本／tag、最终 `develop` 提交 SHA、本次目标版本与源码范围、完整更新说明和检查结果，等待用户确认再推送发布。若这些具体内容已在当前会话确认，沿用确认；确认后发布范围或说明发生实质变化时，重新展示变更并确认。手动触发 workflow dispatch 也遵循此确认点。

确认后核对 `develop` 仍指向确认过的 `release_sha`，先推送远端 `develop`，成功后才在同一提交创建并推送 annotated tag。不为发布推送工作分支；若推送因远端更新而拒绝，先整合变更，再重新核对发布范围、说明和检查结果：

```sh
test "$(git rev-parse develop)" = "$release_sha"
git push origin develop
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
```

确认对应提交的 CI 已触发后，报告版本、源码 SHA、更新说明和 CI 链接，发布技能的执行到此结束。默认不持续跟踪 CI、不核对发布结果，也不执行发布后的额外验证；仅在用户明确要求，或本次相关代码修改需要验证时，按实际范围执行。
