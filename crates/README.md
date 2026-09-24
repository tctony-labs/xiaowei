# Rust 原生模块开发

本文说明 `crates/` 下 Rust 模块的组织结构、依赖边界、原生接入方式和开发约定。Rust 模块采用业务核心与 napi 适配层分离的结构。

## 命名与依赖方向

- `xiaowei-*`：主 App 直接使用的功能入口，例如 npm 包 `xiaowei-search` 及其同名 Rust 核心。对应 napi 绑定 crate 使用 `xiaowei-search-napi`，属于同一个功能入口的适配层。
- `xw-*`：由其他包使用的内部模块，不由主 App 直接依赖，例如 `xw-app`、`xw-bookmark`、`xw-platform`。

目录与 Cargo 包名一致。App 通过 `xiaowei-*` 的公开接口使用能力，功能入口依赖 `xw-*`，内部模块不反向依赖 App 或功能入口。

## 目录与职责

以下以 `xiaowei-search` 为例说明目录布局：

```text
crates/
  xiaowei-search/
    Cargo.toml                 # 纯 Rust 核心：xiaowei-search
    src/
    napi/
      Cargo.toml               # 绑定 crate：xiaowei-search-napi，依赖上层核心
      build.rs
      src/                     # napi 导出、类型转换与异步边界
      package.json             # npm 入口包：xiaowei-search
      index.js                 # napi-rs 生成的平台加载器
      index.d.ts               # napi-rs 生成的 TypeScript 声明
      *.node                   # 本机构建产物
      npm/                     # 按需建立，用于多平台发布
        darwin-arm64/
          package.json         # 平台包的 os、cpu 与二进制入口
          *.node
Cargo.toml                     # Rust workspace
pnpm-workspace.yaml            # npm workspace
```

纯 Rust 核心承载业务，不依赖 Electron 或 napi；`napi/` 将核心能力导出为 Node API，同时作为 npm 包入口。根目录 `packages/` 保留给独立 npm 包，不为同一个 Rust 模块另建一份包装目录。

Electron 主进程依赖 npm 入口包，由 preload 向 renderer 暴露受限 API。耗时业务通过异步绑定执行，避免阻塞 Electron 主线程。Renderer 不直接加载 `.node`。

## 两套 workspace

Cargo workspace 纳入核心 crate 和其 `napi` 子 crate；新增模块时在根 `Cargo.toml` 中登记相应路径。pnpm workspace 通过 `crates/*/napi` 纳入含有 `package.json` 的 napi 入口目录，统一管理依赖和锁文件。

Electron 通过 `workspace:*` 引用本地 npm 入口包，例如 `"xiaowei-search": "workspace:*"`。pnpm workspace 不递归纳入 `napi/npm/*` 平台包，也不在安装时自动编译 Rust。具体工作区成员以根目录配置为准。

## 构建与开发

正常构建流程由各 napi 包的 `package.json` 和 `scripts/dev/` 下的对应构建脚本维护；具体命令、参数和执行顺序以脚本为准，本文不重复维护。

- 修改 Rust 源码（包括内部依赖 crate）、napi 接口或相关依赖与构建配置后，Agent 必须主动构建受影响的 napi 包，生成最新 `.node`、JS 加载入口和类型声明。构建入口以受影响 napi 包的 `package.json` 中的 `build:debug` 脚本为准；内部共享 crate 变更时，沿依赖关系重建所有受影响的 napi 包。
- `cargo check`、Rust 单测和 TypeScript 检查不能代替原生模块构建。构建失败时先修复，不使用旧产物继续验证新接口。
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

业务核心负责注册生产 PB routes，契约集中在 `contracts/`；napi 适配层导出 endpoint，由 main 通过 `attachNative` 接入。endpoint 应复用所属模块的业务实例，避免为通信入口重复创建业务状态。测试 fixture 不进入正式接口。

共享 Gateway Rust 代码变更时，沿依赖关系重建受影响的原生包。通信与生命周期的通用约定见 [Gateway](../gateway/README.md)，桌面接入约定见 [main 装配与生命周期](../desktop/src/main/README.md#gateway-装配与生命周期)。
