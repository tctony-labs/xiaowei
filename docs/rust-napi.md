# Rust 模块通过 napi 接入 Electron

本文约定后续 Rust 模块的统一接入方式，参考 `image-retrieval` 项目的核心与 napi 分层。以 `xiaowei-search` 为例：当前搜索核心及 Electron 接入已实现，本机 arm64 原生构建与打包产物加载已验证；多平台发布尚未配置。

## 命名与依赖方向

- `xiaowei-*`：主 App 直接使用的功能入口，例如 npm 包 `xiaowei-search` 及其同名 Rust 核心。对应 napi 绑定 crate 使用 `xiaowei-search-napi`，属于同一个功能入口的适配层。
- `xw-*`：由其他包使用的内部模块，不由主 App 直接依赖，例如 `xw-app`、`xw-bookmark`、`xw-platform`。

目录与 Cargo 包名一致。App 通过 `xiaowei-*` 的公开接口使用能力，功能入口依赖 `xw-*`，内部模块不反向依赖 App 或功能入口。

旧项目能力按需迁入，保留相关测试，不整包复制尚未使用的平台能力。`xw-platform` 当前包含应用本地化名称、应用图标和 macOS 系统主题切换，拼音和匹配留在 `xiaowei-search`。`xiaowei-clipboard` 承载本地剪贴板业务，接入方式与搜索一致；两个原生包复用 `xw-napi-log` 的日志接收器，各自在所属动态库中初始化。参考源码及相关外部模块位于开发环境的 `~/Develop/XiaoWei/workspace/src/`，构建不依赖这个外部路径。

## 目录与职责

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

纯 Rust 核心承载业务，不依赖 Electron 或 napi；`napi/` 将核心能力导出为 Node API，同时作为 npm 包入口。根目录 `packages/` 保留给独立 npm 包，不再为同一个 Rust 模块另建一份包装目录。

Electron 主进程依赖 npm 入口包，由 preload 向 renderer 暴露受限 API。耗时业务通过异步绑定执行，避免阻塞 Electron 主线程。Renderer 不直接加载 `.node`。

## 两套 workspace

Cargo workspace 纳入核心 crate 和其 `napi` 子 crate；新增模块时登记相应路径。例如：

```toml
[workspace]
resolver = "2"
members = ["crates/*", "crates/xiaowei-search/napi", "crates/xiaowei-clipboard/napi"]
```

pnpm workspace 纳入含有 `package.json` 的 napi 入口目录：

```yaml
packages:
  - desktop
  - packages/*
  - crates/*/napi
```

这使根目录安装统一管理依赖和锁文件，也允许 Electron 用 `"xiaowei-search": "workspace:*"` 引用本地入口包。该配置不递归纳入 `napi/npm/*` 平台包，也不在安装时自动编译 Rust。

## 构建与开发

napi 入口包提供以下脚本：

```json
{
  "scripts": {
    "build": "napi build --platform --release",
    "build:debug": "napi build --platform"
  }
}
```

`just start` 在安装依赖后、停止旧开发实例前，依次执行所有 `crates/*/napi` 包的 `build:debug`，确保新工作区具备本机原生产物；构建失败时退出并保留旧实例。

`pnpm -r build` 执行各工作区包的 `build` 脚本；Electron 声明 `workspace:*` 依赖后，pnpm 按依赖关系先构建 napi 包，再构建桌面端。

`napi build` 默认仅编译当前机器的平台和架构；`--platform` 表示在文件名中加入平台标识，例如 `xiaowei-search.darwin-arm64.node`，不表示编译所有平台。其他目标需要显式指定 target 并准备对应工具链，通常由 CI 分别构建。

修改 Rust 源码、内部依赖 crate、napi 接口或相关依赖与构建配置后，Agent 必须主动执行受影响包的原生构建；当前搜索包执行 `pnpm --filter xiaowei-search build:debug`。`cargo check` 或单测不能代替生成最新 `.node`、JS 入口和类型声明。构建成功后，再按 [AGENTS.md 的运行实例与原生模块规则](../AGENTS.md) 检查归属并执行 `just rs`；没有实例时完成构建并告知用户待验证内容。已加载的原生模块不会随文件更新或前端 HMR 自动替换。`just rs` 仍只触发桌面重建与重启，不附带 Rust 编译，也不新增自动监听机制。

## 本地加载与多平台发布

调用方始终依赖 `xiaowei-search`，由生成的 JS 加载器根据系统、CPU 架构及必要的 ABI 差异选择原生模块：

- 本地开发加载入口包同目录下的 `.node` 构建产物。
- 多平台发布时，入口包通过 `optionalDependencies` 声明平台包；平台包的 `os`、`cpu` 等条件帮助包管理器选择适用依赖，加载器再导入对应平台包。

`napi/npm/<platform>/` 用于组织平台发布包，不是每次递归构建的入口。入口包与平台包的版本、依赖及产物需要一起维护；需要发布时再增加相关配置。当前 npm 包是 private，尚未配置这些平台发布包。

生成的 JS 和类型声明由 napi-rs 更新，不手工维护平台分支或重复的接口声明。桌面打包时须保留加载器及对应原生产物，并确保 `.node` 可从 ASAR 外加载；接入验收应同时覆盖开发环境和打包后的模块加载。

## Gateway 业务入口

搜索的 `createSearchGatewayEndpoint()` 复用搜索初始化和直接 napi 方法所持有的 Service；剪贴板的 `history.createGatewayEndpoint()` 复用当前 history 的 Service。main 通过 `attachNative` 接入 endpoint；生产 PB routes 由 Rust 业务 crate 注册，契约集中在 `contracts/`。既有通用 `createGatewayEndpoint()` 用于空 registry 的传输接入，不等同于搜索业务工厂。

两个原生包分别执行 `pnpm --filter xiaowei-search build:debug`、`pnpm --filter xiaowei-clipboard build:debug`；共享 Gateway Rust 改动需重建两者。业务和原生传输回归可执行 `pnpm gateway:test-native`，测试结束恢复正常构建；fixture 不进入正式接口。打包保留两个 `.node`，不新增 Gateway 动态库。生命周期和 Electron 接入见 [Gateway](../gateway/README.md#electron-与业务接入)。
