# CI 构建缓存

GitHub 的测试 workflow 使用 `actions/cache` 保存 Cargo registry 压缩包、索引、git 依赖和完整 `target/`，包含 workspace crate、Rust 测试和正式／fixture 两种 napi 构建的产物。CI 设置 `CARGO_INCREMENTAL=0`，避免生成和传输增量编译目录；本地开发不受影响。

`cargo-cache.mjs key` 使用 rustc 版本信息、平台、架构和 Rust flags 生成回退前缀，再按 Cargo 文件、Rust 模块与相关构建脚本的内容生成快照 key。Rust 输入变化时先恢复同一编译环境的最新缓存，由 Cargo 判断需要重编的部分；测试成功后保存新 key。相同 Rust 输入直接命中已有快照，避免 GitHub 的不可变缓存一直停留在旧源码产物上。renderer 源码变化不轮换 Cargo key。

重新 checkout 会更新源码时间戳，即使内容相同也可能使 Cargo 判定产物过期。测试成功后，`cargo-cache.mjs save` 将 Git 跟踪的普通文件的内容哈希和修改时间保存到 `target/ci-input-timestamps.json`。下次构建前，`restore` 只为当前内容与快照相同的文件恢复修改时间；改动、新增、删除的文件以及符号链接均不恢复。不会通过回调时间戳把修改后的源码伪装成旧源码。

命令输出缓存 key、恢复／保留的文件数量；GitHub cache step 输出命中结果及传输耗时。首次启用或编译环境改变时需要预热缓存，实际 CI 收益须在后续运行中对比；缓存可能因 GitHub 容量限制被清理，未命中时正常构建。

本地回归通过 `pnpm test:tooling` 执行。其中包含真实 Cargo 构建：模拟恢复缓存和重新 checkout，验证未变源码显示 `Fresh`，改动源码重新编译且二进制行为更新；不访问真实远端服务。

`go-cache.mjs version` 读取 `server/go.mod` 的 `toolchain` 版本供 workflow 安装工具链；没有该指令时使用 `go` 版本。关闭 `setup-go` 内置缓存，由 `actions/cache` 分别保存模块下载和编译／测试缓存。`go-cache.mjs key` 查询实际 Go 版本、`GOMODCACHE`、`GOCACHE`，计算输入内容哈希，输出 workflow 使用的路径、前缀和哈希；前缀包含 runner 平台、架构与实际 Go 版本，本地调用使用当前平台和架构。版本与输入数量输出到 stderr，便于查看 CI 日志，不混入 Actions outputs。

模块下载 key 同时覆盖 `server/` 和 `contracts/go/` 的 `go.mod`、`go.sum`，避免只命中契约依赖的旧快照、漏存服务端下载。编译 key 另外覆盖两个模块的 Go 源码、服务端嵌入的 SQL 迁移、测试 workflow 和 Go 缓存脚本；只读取 Git 跟踪的普通文件，按路径排序并哈希路径和内容。源码变化时恢复相同编译环境的最新快照，测试成功后保存新 key，未变化的包继续复用。renderer 源码变化不轮换 Go key。Go 缓存按内容校验，无需恢复 checkout 后的源码时间戳；新增其他嵌入资源或模块时须同步扩展脚本的 key 输入。

Go 缓存脚本测试同样纳入 `pnpm test:tooling`，覆盖版本选择、两个模块的依赖与源码、SQL 迁移、缓存路径和环境隔离；忽略 renderer、未跟踪文件和源码时间戳变化。
