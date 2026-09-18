# 02：napi 传输适配与联调

主事项：[实现核心 Gateway 通信机制](../../records/active/2026-09-18-implement-gateway.md)。依赖 00、01；本计划范围已由用户确认，尚未实施。先完成本切片验证再改实际业务通信。

## 范围

保留搜索与剪贴板两个 `.node`。让每个模块自己的 Rust registry 能异步请求 main，也能接受 main 的本地 dispatch 和事件订阅。此切片不移动数据库，不引入新的常驻进程或第三个 gateway 原生入口包。Gateway 共两个包：TS `xiaowei-gateway` 与 Rust `xw-gateway`；napi 适配是后者的可选 feature，不另建适配 crate。

## 文件与职责

| 文件／目录 | 修改内容 |
| --- | --- |
| `gateway/rust/Cargo.toml`、`src/napi/mod.rs`、`src/lib.rs` | 添加可选 `napi` feature 和模块：manifest、异步回调、bytes 转换、事件 sink 和关闭；默认纯 Rust 核心不启用 |
| `crates/xiaowei-search/napi/src/gateway.rs` | 搜索动态库的 registry 与 napi 接入对象 |
| `crates/xiaowei-clipboard/napi/src/gateway.rs` | 剪贴板动态库的 registry 与 napi 接入对象 |
| 两个 napi 的 `src/lib.rs`、`Cargo.toml` | 依赖 `xw-gateway` 并开启 `napi` feature，导出 endpoint 薄封装及显式生命周期接口；业务核心不开启该 feature，现有业务 API 暂保留 |
| `gateway/ts/src/main/native.ts` | main 接受 manifest、绑定 owner、dispatch 与反向 callback；不直接 import 具体业务包 |
| napi 集成测试及测试 fixture | 在普通 Node 进程内同时加载两个真实 `.node`，不用 Electron、不碰用户数据库和系统剪贴板 |

## 执行步骤

1. 先做最小技术验证：Rust tokio future → napi threadsafe callback → JS Promise → Rust 结果。验证 JS reject、字节值、关闭时 callback 失效；严禁同步等待 JS、阻塞 Node 主线程或持有 registry／数据库锁等待回调。若当前 napi 能力无法满足，报告具体阻碍，不改成 socket／sidecar 或合并原生包。
2. 为每个模块实例创建并持有自己的 `Arc<Registry>`，业务和 napi adapter 使用同一个实例。共享 crate 只复用代码，不用全局 static 冒充跨 `.node` 总线。通用适配在 `xw-gateway::napi` 实现，各业务 napi 包只导出薄封装；endpoint 的 manifest／绑定／本地 dispatch／事件订阅与取消／关闭契约按 record 落实，不能把业务 route 名硬编码到通用适配中。
3. endpoint manifest 来自生成的定义；napi-rs 声明负责 native 入口，业务绑定负责 route 类型与校验，不能混为一种生成。设计明确接入顺序：创建 endpoint、装载本地 handler → main 检查并预留 manifest 名称 → 注入 outbound callback／event sink → 原子发布并标记 ready。启动失败回滚全局注册和 native 资源；对外发布前不接受业务请求。
4. main → native 只使用 `dispatchLocal`；native fallback → main 携带由 adapter 绑定的来源上下文。main 发现目标仍是来源且本地未命中时返回错误，不再次路由。运行中新增 route／event 同样先经全局冲突检查。
5. 原生接口通过 Promise 返回结果；Rust 当前同步业务操作继续使用异步 blocking 适配，不能在 Electron 线程直接跑 SQLite。回调队列满／环境退出必须显式结束请求，不能把 NonBlocking 投递失败当成功。
6. 注册与事件使用相同 owner 生命周期。Rust 能订阅另一个 owner 的事件；本地事件本地投递，远端订阅经 main 转发，不重复交付。native 注销时释放 TSFN、sink、pending 和订阅；JS GC 不替代显式 close。
7. 为 Plan 03 的 stream open／next／cancel 预留 transport adapter 契约；本切片先验证 Promise pending 时反向控制请求仍可处理，不用同步锁串行阻塞所有 endpoint 操作。跨语言适配显式处理 PB 字节／Buffer 及统一控制错误。公共 TS 类型保留原生成类型，不手改 napi 生成加载器和声明。

## 自动验证

在测试构建专用 fixture／feature 中导出测试 handler，不向正式产品注册 `test.*` route：

- Rust A 本地调用不进入 JS；A → main → Rust B 返回结果，B → main → A 也可用，证明没有误用共享全局内存。
- A handler 等待 B，B 异步回调 main 可完成；无锁跨 await；循环／重入在并发或超时边界终止，不死锁进程。
- A 发布、B 订阅；取消、owner 关闭和重新接入不重复投递、不保留旧 callback。
- native manifest 与 TS handler、另一个 native owner 重名时原子失败；迟到关闭不注销新 owner。
- Uint8Array／Buffer 全字节值与多 MiB 内容往返相等，不变成 JSON 数字数组或 Base64；日志不打印 payload。
- Promise rejection、回调失败、handler 超时、close 中在途请求都能结束，测试 Node 子进程可自然退出。

## 构建与收尾

先验证 `cargo test -p xw-gateway --no-default-features`，再执行两个受影响包的 `build:debug`，再运行各自 napi 测试与 gateway 联调测试；cargo check／Rust 单测不能代替 `.node` 构建。确认当前工作区运行实例归属后才能 `just rs`；无实例则不冷启动，并报告桌面验证待办。

原生 API 的技术验证若失败，本切片未完成，不推进业务迁移。通过后回填主 record 的回调、关闭和构建约定，再删除本 Plan。
