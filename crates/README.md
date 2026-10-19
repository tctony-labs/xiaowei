# Rust 原生模块开发

## 模块索引

| 模块 | 职责 |
| --- | --- |
| [xw-search](xw-search/README.md) | 全局搜索核心 |
| [xw-clipboard](xw-clipboard/) | 本地剪贴板业务核心 |
| [xw-storage](xw-storage/README.md) | 存储、设置核心 |
| [xiaowei-rust](xiaowei-rust/README.md) | Storage／Clipboard／Search／Platform 聚合 napi 入口 |
| [xw-platform](xw-platform/README.md) | 通用原生系统能力实现 |
| [xiaowei-agent](xiaowei-agent/README.md) | Agent Gateway／LLM 集成与 napi 入口 |
| [xw-agent](xw-agent/README.md) | 传输无关的 Agent App Server、SQLite 会话目录、投影与业务恢复 |
| [xw-agent-runtime](xw-agent-runtime/README.md) | 单次生成收集、取消、文件工具与写入权限检查 |
| [xw-agent-rollout](xw-agent-rollout/README.md) | JSONL 文件提交、跨进程写锁与未提交尾部修复 |
| [xw-agent-types](xw-agent-types/README.md) | Agent 内部领域类型、精简历史编解码与回放校验 |
| [xw-app](xw-app/) | 应用数据源 |
| [xw-bookmark](xw-bookmark/) | 浏览器书签数据源 |
| [xw-tokenizer](xw-tokenizer/README.md) | SQLite FTS5 分词 |
| [xw-napi-log](xw-napi-log/) | 原生模块日志接收器 |

## 开发约定大纲

- [命名与依赖方向](#命名与依赖方向)
- [目录与职责](#目录与职责)
- [两套 workspace](#两套-workspace)
- [构建与开发](#构建与开发)
- [实现易错点](#实现易错点)
- [本地加载与多平台发布](#本地加载与多平台发布)
- [Gateway 业务入口](#gateway-业务入口)

## 命名与依赖方向

- `xiaowei-*`：主 App 直接使用的功能入口，例如 npm 包 `xiaowei-agent` 及其同名 Rust 集成入口。对应 napi 绑定 crate 使用 `xiaowei-agent-napi`，属于同一个功能入口的适配层。
- `xw-*`：供其他 Rust 包使用的业务实现、支撑模块或通用能力，不由主 App 直接依赖，例如 `xw-app`、`xw-bookmark`、`xw-platform`。

内部 crate 的目录与 Cargo 包名一致；`napi/` 目录中的 Cargo 包使用所属入口名加 `-napi`。App 通过 `xiaowei-*` 的公开接口使用能力，功能入口依赖 `xw-*`，业务实现与支撑模块不反向依赖 App 或功能入口。`xw-platform` 是通用平台能力，任意有需要的 Rust 模块均可直接依赖。

## 目录与职责

当前 npm 入口保留在所属模块的 `napi/` 下。常规业务聚合包没有额外的空转发 crate，直接依赖内部业务核心：

```text
crates/
  xiaowei-rust/
    README.md
    napi/
      Cargo.toml          # xiaowei-rust-napi，cdylib
      package.json        # npm：xiaowei-rust
      src/
        search/
        clipboard/
        storage/
        platform/
        gateway.rs        # 共用 napi endpoint，保留各业务资源生命周期
        logging.rs        # 当前 addon 的单一日志接收器
      index.js            # napi-rs 生成的加载器
      index.d.ts          # napi-rs 生成的声明
      *.node
  xiaowei-agent/
    Cargo.toml            # Agent 集成入口
    src/
    napi/                 # xiaowei-agent-napi；npm：xiaowei-agent
  xw-search/
  xw-clipboard/
  xw-storage/
  xw-platform/
```

内部 `xw-*` crate 承载业务实现和通用能力，不依赖 Electron 或 napi。`xiaowei-rust-napi` 只负责公开接入、类型转换、异步调度和资源所有权适配，不把业务算法搬进绑定层。Agent 保持独立 `.node`；两个 addon 共享的 Rust 依赖仍分别参与链接。 分发体积的保留边界与后续测量方法见 [体积维护与优化边界](../desktop/docs/macos-release.md#体积维护与优化边界)。

同一常规 addon 内只有一个 `GatewayEndpoint` 导出类型，各 endpoint 的 registry、owner 与服务实例仍独立。Storage 的数据库关闭职责、Clipboard 的停止／资源清理顺序保留；业务间继续通过既有 Gateway 调用。常规业务共享一次日志初始化，Agent 日志独立。根目录 `packages/` 保留给独立共享 npm 包。

Electron 主进程依赖 npm 入口包，由 preload 向 renderer 暴露受限 API。耗时业务通过异步绑定执行，避免阻塞 Electron 主线程。Renderer 不直接加载 `.node`。

## 两套 workspace

Cargo workspace 通过 `crates/xw-*` 纳入内部核心，显式登记 Agent 集成入口和两个 `napi` 子 crate；新增模块时在根 `Cargo.toml` 中登记相应路径。pnpm workspace 通过 `crates/*/napi` 纳入含有 `package.json` 的 napi 入口目录，统一管理依赖和锁文件。

Electron 通过 `workspace:*` 引用本地 npm 入口包，当前为 `"xiaowei-rust": "workspace:*"` 与 `"xiaowei-agent": "workspace:*"`。pnpm workspace 不递归纳入 `napi/npm/*` 平台包，也不在安装时自动编译 Rust。具体工作区成员以根目录配置为准。

## 构建与开发

正常构建流程由各 napi 包的 `package.json` 和 `scripts/dev/` 下的对应构建脚本维护；具体命令、参数和执行顺序以脚本为准，本文不重复维护。

- 修改 Rust 源码（包括内部依赖 crate）、napi 接口或相关依赖与构建配置后，Agent 必须主动构建实际受影响的 napi 包，生成最新 `.node`、JS 加载入口和类型声明。构建入口以对应 napi 包的 `package.json` 中的 `build:debug` 脚本为准。
- 共享 crate 变更时，根据各 napi 包实际使用的 API、类型及实现路径确定重建范围，并考虑共享初始化、ABI、编译配置和链接行为的变化。仅依赖同一 crate，或 Cargo 会重新编译该 crate，不构成重建所有依赖包的理由。例如，修改 Sparkle 更新实现时需重建 `xiaowei-rust`；若改动未涉及 Agent 的依赖或运行行为，则无需重建 `xiaowei-agent`。
- 对实际受影响的 napi 包，`cargo check`、Rust 单测和 TypeScript 检查不能代替原生模块构建。构建失败时先修复，不使用旧产物继续验证新接口。
- 有运行实例时，按 [AGENTS.md 的运行实例规则](../AGENTS.md#运行实例) 确认归属后可直接执行 `just rs`，由共用构建入口完成 napi 增量构建并重启；必须确认构建成功且 Electron 加载新模块。已加载的 `.node` 不会随文件更新或前端 HMR 自动替换。
- 没有当前工作区实例时，仍须完成原生模块构建，再告知用户启动后待验证的内容。`just rs` 通过已有 nodemon 流程触发 napi 构建，不新增 Rust 源码自动监听或自动重启机制。

## 实现易错点

### Objective-C 内存管理

- Rust 工作线程调用 Objective-C / Foundation / AppKit 时，在同步调用边界使用 `objc2::rc::autoreleasepool`，除非已确认当前线程有会及时 drain 的外层 pool。
- `Retained<T>` 只管理持有的引用，不能替代 pool 回收框架内部的 autoreleased 临时对象。
- Electron 主线程的 pool 不覆盖 Rust 工作线程，不能依赖主线程的回收机制。
- 循环任务按次或按批 drain，不把 pool 包在整个长期线程外，也不跨 `await`。
- 字符串、字节等应在 pool 内转为 Rust 拥有的数据后返回。

## 本地加载与多平台发布

调用方依赖对应的 `xiaowei-*` npm 入口包，由生成的 JS 加载器根据系统、CPU 架构及必要的 ABI 差异选择原生模块：

- 本地开发加载入口包同目录下的 `.node` 构建产物。
- 多平台发布时，入口包通过 `optionalDependencies` 声明平台包；平台包的 `os`、`cpu` 等条件帮助包管理器选择适用依赖，加载器再导入对应平台包。

`napi/npm/<platform>/` 用于组织平台发布包，不是每次递归构建的入口。入口包与平台包的版本、依赖及产物需要一起维护；需要发布时再增加相关配置。是否发布及平台包配置以对应包的 `package.json` 为准。

生成的 JS 和类型声明由 napi-rs 更新，不手工维护平台分支或重复的接口声明。桌面打包时须保留加载器及对应原生产物，并确保 `.node` 可从 ASAR 外加载；接入验收应同时覆盖开发环境和打包后的模块加载。

## Gateway 业务入口

业务 handler 模块的命名与边界遵循 [Gateway 接入约定](../gateway/README.md#接入约定)。

业务入口负责注册生产 PB routes，契约集中在 `contracts/`；Agent 的 `xw-agent` 仅消费协议类型，Gateway 接入归 `xiaowei-agent` 集成层，runtime／types 不依赖通信契约。napi 适配层导出 endpoint，由 main 通过 `attachRustNapi` 接入。endpoint 应复用所属模块的业务实例，避免为通信入口重复创建业务状态。测试 fixture 不进入正式接口。

共享 Gateway Rust 代码变更时，沿依赖关系重建受影响的原生包。通信与生命周期的通用约定见 [Gateway](../gateway/README.md)，桌面接入约定见 [main 装配与生命周期](../desktop/src/main/README.md#gateway-装配与生命周期)。
