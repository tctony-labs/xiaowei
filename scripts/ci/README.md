# CI 构建缓存

GitHub 的测试 workflow 使用 `actions/cache` 保存 Cargo registry 压缩包、索引、git 依赖和完整 `target/`，包含 workspace crate、Rust 测试和正式／fixture 两种 napi 构建的产物。CI 设置 `CARGO_INCREMENTAL=0`，避免生成和传输增量编译目录；本地开发不受影响。

`cargo-cache.mjs key` 使用 rustc 版本信息、平台、架构和 Rust flags 生成回退前缀，再按 Cargo 文件、Rust 模块与相关构建脚本的内容生成快照 key。Rust 输入变化时先恢复同一编译环境的最新缓存，由 Cargo 判断需要重编的部分；测试成功后保存新 key。相同 Rust 输入直接命中已有快照，避免 GitHub 的不可变缓存一直停留在旧源码产物上。renderer 源码变化不轮换 Cargo key。

重新 checkout 会更新源码时间戳，即使内容相同也可能使 Cargo 判定产物过期。测试成功后，`cargo-cache.mjs save` 将 Git 跟踪的普通文件的内容哈希和修改时间保存到 `target/ci-input-timestamps.json`。下次构建前，`restore` 只为当前内容与快照相同的文件恢复修改时间；改动、新增、删除的文件以及符号链接均不恢复。不会通过回调时间戳把修改后的源码伪装成旧源码。

命令输出缓存 key、恢复／保留的文件数量；GitHub cache step 输出命中结果及传输耗时。首次启用或编译环境改变时需要预热缓存，实际 CI 收益须在后续运行中对比；缓存可能因 GitHub 容量限制被清理，未命中时正常构建。

本地回归通过 `pnpm test:tooling` 执行。其中包含真实 Cargo 构建：模拟恢复缓存和重新 checkout，验证未变源码显示 `Fresh`，改动源码重新编译且二进制行为更新；不访问真实远端服务。
