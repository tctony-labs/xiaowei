# CI 构建缓存

GitHub 的测试和 macOS release workflow 使用 `actions/cache` 保存 pnpm store、Go 模块与编译缓存，以及 Cargo registry 压缩包、索引、git 依赖和完整 `target/`。Cargo 缓存包含 workspace crate、Rust 测试和生产／fixture napi 的编译产物；release 构建还会产生优化 profile 产物。CI 设置 `CARGO_INCREMENTAL=0`，避免生成和传输增量编译目录；本地开发不受影响。

两条 workflow 使用相同的缓存路径、key 和回退前缀，key 不包含分支或 tag。GitHub 允许 tag 运行恢复默认分支的缓存，本仓库默认分支为 `develop`；不同 tag 自己保存的缓存彼此隔离，不能由后续 tag 直接恢复。因此 release 可以复用 develop 测试缓存中的依赖与匹配构建产物，但只有 debug 产物时，首次 release profile 仍需编译；不能据此宣称已实现跨版本的完整 release 产物复用。pnpm 缓存按平台、架构和 lockfile 哈希查找，未命中时回退到同平台和架构的最近快照。

`cargo-cache.mjs key` 使用 rustc 版本信息、平台、架构和 Rust flags 生成回退前缀，再按 Cargo 文件、Rust 模块、测试／release workflow 与相关构建脚本的内容生成快照 key。Rust 输入变化时先恢复同一编译环境的最新缓存，由 Cargo 判断需要重编的部分；workflow 成功后保存新 key。相同 Rust 输入直接命中已有快照，避免 GitHub 的不可变缓存一直停留在旧源码产物上。renderer 源码变化不轮换 Cargo key。

重新 checkout 会更新源码时间戳，即使内容相同也可能使 Cargo 判定产物过期。两条 workflow 都在 Rust 编译前执行 `cargo-cache.mjs restore`，测试成功后执行 `save`，将 Git 跟踪的普通文件的内容哈希和修改时间保存到 `target/ci-input-timestamps.json`。`restore` 只为当前内容与快照相同的文件恢复修改时间；改动、新增、删除的文件以及符号链接均不恢复。不会通过回调时间戳把修改后的源码伪装成旧源码。release 不缓存打包、签名、公证后的应用或安装包，仍从本次编译输出生成分发产物。

命令输出缓存 key、恢复／保留的文件数量；GitHub cache step 输出命中结果及传输耗时。首次启用或编译环境改变时需要预热缓存，实际 CI 收益须在后续运行中对比；缓存可能因 GitHub 容量限制被清理，未命中时正常构建。

本地回归通过 `pnpm test:tooling` 执行。其中包含真实 Cargo 构建：模拟恢复缓存和重新 checkout，验证未变源码显示 `Fresh`，改动源码重新编译且二进制行为更新；不访问真实远端服务。

`go-cache.mjs version` 读取 `server/go.mod` 的 `toolchain` 版本供 workflow 安装工具链；没有该指令时使用 `go` 版本。关闭 `setup-go` 内置缓存，由 `actions/cache` 分别保存模块下载和编译／测试缓存。`go-cache.mjs key` 查询实际 Go 版本、`GOMODCACHE`、`GOCACHE`，计算输入内容哈希，输出 workflow 使用的路径、前缀和哈希；前缀包含 runner 平台、架构与实际 Go 版本，本地调用使用当前平台和架构。版本与输入数量输出到 stderr，便于查看 CI 日志，不混入 Actions outputs。

模块下载 key 同时覆盖 `server/` 和 `contracts/out/proto-server-go/` 的 `go.mod`、`go.sum`，避免只命中契约依赖的旧快照、漏存服务端下载。编译 key 另外覆盖两个模块的 Go 源码、服务端嵌入的 SQL 迁移、测试／release workflow 和 Go 缓存脚本；只读取 Git 跟踪的普通文件，按路径排序并哈希路径和内容。源码变化时恢复相同编译环境的最新快照，workflow 成功后保存新 key，未变化的包继续复用。renderer 源码变化不轮换 Go key。Go 缓存按内容校验，无需恢复 checkout 后的源码时间戳；新增其他嵌入资源或模块时须同步扩展脚本的 key 输入。

Go 缓存脚本测试同样纳入 `pnpm test:tooling`，覆盖版本选择、两个模块的依赖与源码、SQL 迁移、缓存路径和环境隔离；忽略 renderer、未跟踪文件和源码时间戳变化。

## 排障与验证

缓存命中只说明文件已恢复，不能证明编译器实际复用了产物。Cargo 仍重编时，先检查精确／回退 key、时间戳恢复结果及实际构建参数；workflow 的测试步骤已设置 `CARGO_LOG=cargo::core::compiler::fingerprint=info`，从失效日志确认具体原因，并结合 verbose 构建的 `Fresh`／`Compiling` 输出判断。napi 构建经过 `scripts/dev/build-napi.mjs` 注入路径 remap flags，排查时须核对该入口实际传入的 flags 和构建路径；基础 Cargo fixture 通过不等于跨 runner 的 napi 缓存复用已验证。

修改缓存脚本可定向执行 `node --test scripts/ci/*.test.mjs`。Cargo 回归使用离线真实构建，同时检查未变输入复用及源码改动后二进制输出更新；Go 回归检查 key 输入与环境，不验证真实跨 CI 的编译缓存收益。CI 强制彩色 Cargo 输出，日志文本断言先用 Node 的 `stripVTControlCharacters` 去掉控制序列，保留原始 stderr 用于失败诊断，避免颜色打断匹配造成假失败。

评估收益时，对比相同 runner／工具链下的冷缓存、精确命中与输入变化后的回退命中，分别查看缓存传输、原生构建和测试步骤的耗时，并计入保存成本。以真实 workflow 的结果确认净收益，不能把缓存命中或新增诊断日志视为提速已完成。
