# 本地打包与验证

本文件承载按需执行的本地操作。正式发布流程见 [release-desktop-app](../SKILL.md)，参数和产物机制见 [设计文档](../../../../desktop/docs/macos-packaging-and-updates.md)。本地打包不等同于正式发布；Agent 不冷启动 Electron。

## 本地打包

准备工作区依赖、固定的 Node／pnpm／Rust 工具链和 Xcode Command Line Tools，在 Apple Silicon Mac 上执行。环境须提供正式长期密钥对应的 `SPARKLE_ED_PUBLIC_KEY`，值为 32 字节 Ed25519 公钥的 Base64；不要用临时测试公钥分发正式应用。

```sh
pnpm --dir desktop package:mac
```

默认使用 ad-hoc 签名，不公证、不上传、不启动应用。只生成 app 目录和调试归档时使用：

```sh
pnpm --dir desktop package:mac --dir
```

正式签名打包需显式提供设计文档 [CI 配置](../../../../desktop/docs/macos-packaging-and-updates.md#ci-配置) 对应的本地环境变量。证书名须为完整的 `Developer ID Application: <姓名> (<Team ID>)`，与 Team ID 一致；缺少配置不得回退到开发证书或测试密钥。

```sh
pnpm --dir desktop package:mac --signed
```

需要签名目录包时可组合 `--signed --dir`；它走 app 临时 ZIP 公证路径。通用 `pnpm --dir desktop package` 不携带 Sparkle，不用于更新验收。

完成 DMG／ZIP 后，使用匹配当前应用版本的 `release_tag`，提供 `SPARKLE_ED_PUBLIC_KEY`、`SPARKLE_ED_PRIVATE_KEY` 和对应的 `desktop/release-notes/<version>.md`，校验并生成正式 appcast：

```sh
node scripts/release/check-release.mjs "$release_tag"
node scripts/release/release-notes.mjs "$release_tag"
node scripts/release/generate-appcast.mjs "$release_tag"
```

`generate-appcast.mjs` 还需要可访问发布仓库的 GitHub CLI 登录态或 `GH_TOKEN`，会下载并验证最近 3 个较旧稳定版本的更新 ZIP 与签名 feed。核对日志中的基线、实际 delta 数量及体积，并确认 feed 列出的 `.delta` 全部位于 `desktop/dist/`。没有历史版本或工具未生成合适补丁时，feed 仍提供完整 ZIP。

基线被生成器判定不兼容时，按设计文档的 [签名与下载契约](../../../../desktop/docs/macos-packaging-and-updates.md#签名与下载契约) 核对已知边界；不要修改或重新签名历史基线来绕过生成器检查。

`check-release.mjs` 还需要正式签名／公证环境变量，不用于无凭据的 ad-hoc 联调。核对 app、DMG、更新 ZIP、delta、调试 ZIP 和 feed 的版本，检查签名、公证和验签结果；生成失败不上传部分产物。

## 本地两版本更新联调

```sh
pnpm --dir desktop package:mac:test
pnpm --dir desktop update:mac:serve
```

此入口生成一套临时 Ed25519 密钥签名的两个 ad-hoc 测试版本，不需要 Developer ID、公证或手工配置密钥。测试数据与正式数据隔离，路径和实现见设计文档的 [本地两版本更新联调](../../../../desktop/docs/macos-packaging-and-updates.md#本地两版本更新联调)。测试包快捷键仍可能与开发实例冲突，先由用户正常退出开发实例。

产物位于 `desktop/dist/local-update/`；已有成功测试对时准备入口拒绝覆盖。需要重做时先将该目录移到别处；新生成的包和 feed 必须成对使用。测试服务仅监听本机，不启动 Electron，可用 Ctrl-C 停止。

1. 保持正常更新源运行。由用户启动 `desktop/dist/local-update/installed/XiaoWei Local Update.app` 旧版副本；或从旧版 DMG 拖至可写的 Applications 目录再启动。不要在 DMG 只读卷中更新，也不要先安装新版。
2. 在关于页确认旧版本，创建可识别的测试设置、剪贴板条目或 Agent 会话，可选记录数据文件内容以便比较。
3. 点击检查更新，核对 Sparkle 识别新版；先取消下载／安装，确认旧版可用。关闭服务检查网络失败，恢复服务后继续。
4. 分别用下列模式检查错误显示和日志，确认损坏的 feed 或完整 ZIP 被拒绝。每次切换先停止前一个服务，并关闭上一轮 Sparkle 窗口；测试后恢复正常服务。

   ```sh
   pnpm --dir desktop update:mac:serve invalid-feed
   pnpm --dir desktop update:mac:serve invalid-archive
   ```

5. 正常下载并安装，确认服务日志实际请求 `.delta`，应用日志先记录 `prepare-install` 与业务关闭，再由 Sparkle 替换、重启；关于页变成新版，原数据仍在，同版本检查不再提示升级。
6. 退出测试应用，从 `test.json` 的 `oldApp` 重新复制旧版到 `installed/` 后，由用户启动并使用 `full-only` 模式重复更新，确认 feed 没有 delta、服务只收到完整 ZIP 下载。每次成功更新后都需恢复旧版副本，才能继续其他更新场景。

   ```sh
   pnpm --dir desktop update:mac:serve full-only
   pnpm --dir desktop update:mac:serve invalid-delta
   ```

7. 使用 `invalid-delta` 检查损坏补丁的签名拒绝及后续行为。再恢复正常源，在运行中的旧版副本 `Contents/Resources/` 新增无关测试文件，使安装基线与发布包不一致；触发更新，核对补丁应用失败后下载完整 ZIP、完成安装并保留数据。记录实际请求与错误，不把签名拒绝等同于补丁应用失败。
8. 核对测试包进程、独立日志和下载请求，记录实际结果。普通 Node 加载 addon 或单独运行 `BinaryDelta` 不代替 Electron 安装和回退验证。本地 ad-hoc 联调不代替正式签名、公证和公开下载链路验收。

当前本地测试 feed 未填更新说明，不能用它验收正式 Release 的说明正文。正文的签名嵌入由 tooling 测试覆盖，实际显示还需用正式 feed 验证。

## 更新密钥准备

普通发布复用现有长期密钥。只有用户明确要求首次准备或重新导出现有密钥时，才执行：

```sh
scripts/release/sparkle_generate_keys.sh
```

脚本使用已固定的 Sparkle `generate_keys`，在登录 Keychain 的 `xiaowei` account 中生成或读取密钥，导出至 `/tmp/xiaowei-sparkle-private-key.txt`（权限 `0600`）。目标文件已存在时拒绝覆盖，导出前验证配对，只输出公钥与路径。

由发布者备份并将文件中的 Base64 私钥配置为仓库 Actions secret `SPARKLE_PRIVATE_KEY`，完成后移除临时导出文件。无需新增 org 公钥变量；私钥、密码、证书不得进入对话、日志、技能或版本库。

## 调试归档与崩溃定位

保留同一次构建的 `.map` 与 dSYM 时，可重跑归档入口：

```sh
node scripts/release/debug-symbols.mjs desktop/dist/mac-arm64/XiaoWei.app
```

核对 `manifest.json` 的版本、commit、原生 UUID 和各文件 SHA-256。符号必须来自实际发布的同一次构建，之后重新编译不能替代。Electron 官方符号按 manifest 的 URL 下载，先校验 SHA-256，再核对模块 UUID。

Rust 崩溃先核对 `.ips` 和 dSYM 的 UUID：

```sh
xcrun dwarfdump --uuid native/xiaowei-agent.darwin-arm64.node.dSYM
```

使用 `atos -arch arm64 -o <dSYM 内 Contents/Resources/DWARF 下的文件> -l <模块加载地址> <崩溃地址>` 还原位置。LLDB／`atos` 使用 dSYM，Electron minidump 使用官方 `symbols.zip`。JS 堆栈使用 `javascript/out/` 对应的 `.map`，Node `SourceMap.findEntry` 的行列号从 0 开始。

## 包体积与隔离验证

1. 下载待比较版本的正式 DMG，核对长度及 GitHub asset SHA-256；不能混用正式包、ad-hoc 包和安装后修改的 app。
2. 只读挂载 DMG，统计 app 普通文件逻辑字节数，跳过符号链接。分别记录 DMG 压缩大小与 app 展开大小，不以卷容量或磁盘块占用代替。
3. 核对 Electron Framework、ASAR、原生模块、语言、source map 及依赖组成。与设计文档链接的 `v0.1.2` baseline 按相同口径比较。
4. 记录版本、源码、架构、工具链和签名方式；跨版本总差异不直接归因于某项优化，单项收益需使用同源码、同构建条件对照。重大优化按 record 生命周期处理，不向归档记录追加新结果。
5. 包内容隔离验收时，将 ASAR 解包到工作区之外，验证 native 加载器，并设置 `XIAOWEI_TEST_BUNDLED_MAIN_DIR=<解包目录>/out/main` 对包内 worker 执行 `desktop/tests/llm/bundled-worker.test.mjs`。构建图检查使用 `scripts/dev/desktop-source-resolution.test.mjs`；不要启动应用代替这些静态和隔离检查。
