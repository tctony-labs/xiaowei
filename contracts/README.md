# Protobuf 契约

`proto/` 是消息和接口的唯一手写来源。TS、Rust、Go 包只提供消息、codec 和接口描述，不依赖 Gateway、Electron、napi 或 gRPC。

## 组织与消费

- [`proto/xiaowei/`](proto/xiaowei/README.md)：业务契约与设计规则；具体字段、方法语义写在 proto 注释中。
- [`proto/xiaowei/server/`](proto/xiaowei/server/README.md)：服务端契约与客户端错误处理约定。
- [`proto/testing/`](proto/testing/)：生成、编解码和传输验证使用的独立测试契约，不向产品注册。
- [`ts/`](ts/)：npm 包 `xiaowei-contracts`，workspace 消费者添加 `"xiaowei-contracts": "workspace:*"`。入口导出消息和 service descriptor；使用方须支持 TS 源码及 enum 转译。
- [`rust/`](rust/)：crate `xw-contracts`，通过 Cargo path 依赖消费。`FILE_DESCRIPTOR_SET` 提供文件／服务／方法描述，`prost::Name` 提供消息全名。消费已入库产物无需 protoc。
- [`go/`](go/)：module `github.com/tctony-labs/xiaowei/contracts/go`。本地消费者在自己的 go.mod 中 require，并用 replace 指向该目录；不复制生成文件，不要求根 go.work。
- [`tools/`](tools/)：生成时使用的 Rust codegen，不是契约运行依赖。

## 书写顺序

业务 proto（包括 Gateway 与服务端契约）统一按以下顺序组织：

1. 文件头：`syntax`／`edition`、`package`、`import`、文件级 `option`（如有）。
2. service 定义：放在类型声明前，先展示接口及其请求、响应类型。
3. 公共 enum 与数据 message：按依赖关系排列，相关 enum 放在使用它的数据 message 前，基础类型放在组合类型前；同一业务概念的类型相邻，不将所有 enum 单独集中排列。
4. 接口专用类型：接口组的顺序与 service 中的 RPC 顺序一致，每组按 Request、专用结果类型、Response 排列。仅该接口使用的 enum 和辅助 message 放在使用它们的类型前面。

不将所有 Request 和所有 Response 分别集中排列。复用公共类型时不重复声明；请求复用 Empty 时不新增空 Request。

## 生成与检查

从仓库根目录运行：

```sh
just gen
pnpm contracts:check
pnpm contracts:test
```

`just gen` 自动先执行 `just prepare`，安装锁定的工作区依赖并初始化 Git hooks，然后生成语言契约和 descriptor，最后生成 Gateway Rust 绑定。`contracts:check` 校验工具版本后，若输入及产物的内容指纹命中上次成功检查的缓存，则跳过生成与比较；否则在临时目录重建并比较文件集合与内容，不改写源码或产物。`contracts:test` 验证生成规则和三语言 codec，不启动桌面或读取用户数据。

codec 测试记录每次原生调用的 case、语言顺序、模式、输入字节数、退出码和耗时，不输出输入内容。单次原生调用最多等待 10 秒，超时强制结束并使测试失败；无效 wire 只接受正常退出后的非零码，超时、信号终止和启动失败均不能算作正确拒绝。测试入口中的构建及测试阶段设 10 分钟上限，Cargo target 查询设 30 秒上限；入口还验证子进程超时终止与异常判定。

本地业务默认生成 TS／Rust。服务端业务契约集中在 `proto/xiaowei/server/`，Go 通过 `xiaowei/server/**/*.proto` 自动选择整个目录；引用的公共消息仍通过 import 依赖自动纳入生成。目录组织不替代 proto 中的 package 声明。

产物 `ts/src/gen/`、`rust/src/gen/` 和 `go/gen/` 全部入库，禁止手改。新增 TS 文件或 Rust package 时同步维护公共入口导出。具体修改步骤见 [维护 Gateway 业务契约](../.agent/skills/maintain-gateway-contract/SKILL.md)。

生成需要 curl、unzip、Node／pnpm、Cargo 和 Go，首次下载需要网络。

## 文件选择与语言映射

[generate.config.json](generate.config.json) 按语言选择入口，规则相对于 `proto/`，支持文件名和 glob。生成器通过 protoc 的 `FileDescriptorSet` 解析依赖，再为每种语言展开入口及其递归依赖的项目内 proto，包括 public import；结果排序去重。官方 well-known types 使用语言运行库，不额外生成。

三个语言键必须显式配置。空数组关闭该语言的生成；非空规则匹配不到文件时失败，避免规则拼写错误导致产物被清空。缩小范围或关闭某语言前，需要同步检查消费者和测试；三语言 codec 测试依赖测试契约在三端均有产物。

Go 产物按 proto 相对目录组织。生成器读取 [go/go.mod](go/go.mod) 的 module，统一映射所有选中项目 proto 的 Go import 路径，覆盖 proto 内的 `go_package`；跨文件引用使用相同映射，官方 well-known types 保持运行库路径。

实现见 [generate.mjs](scripts/generate.mjs) 和 [proto-selection.mjs](ts/proto-selection.mjs)。

## 生成与漂移检查的边界

生成和检查使用同一配置；检查未命中缓存时，与生成模式一样先在临时目录完成各语言生成：

- 生成模式替换对应产物目录，移除不再需要的旧文件；缩小配置范围或关闭某语言会删除其多余产物。
- 检查模式比较文件集合及字节内容，缺失、多余或陈旧文件均失败；不修改源码、生成产物或暂存区，但允许安装工作区依赖、更新工具和构建缓存。

检查成功后将内容指纹保存在 `target/contracts-check.sha256`，覆盖 proto、生成脚本与配置、依赖清单与锁文件、工具链配置及三语言产物。新增、删除或修改这些文件均使缓存失效；检查失败不写入缓存。删除此缓存文件可强制重新检查。

漂移检查只证明当前源码与产物一致，不证明历史兼容性或业务正确性。文件选择、递归依赖和配置边界由 [选择规则测试](ts/test/proto-selection.test.mjs) 覆盖，跨语言编解码由 [codec 测试](tests/codec.mjs) 覆盖。

## 工具隔离与缓存

工具版本、下载校验值和支持的平台以 [ensure-protoc.mjs](scripts/ensure-protoc.mjs)、[ensure-protoc-gen-go.mjs](scripts/ensure-protoc-gen-go.mjs)、依赖清单及锁文件为准，不自动跟随最新版本。

- protoc 从官方 release 下载，校验固定 SHA-256、可执行版本和 include 目录后原子安装。复用时检查平台及安装元数据；缓存属于当前机器，不能跨架构同步。
- Go 插件按固定版本安装到独立缓存，安装子进程使用临时 GOBIN，校验后原子移入版本目录。同版本可跨项目复用，不同版本并存，不覆盖全局插件。
- ES 插件由 [ensure-protoc-gen-es.mjs](scripts/ensure-protoc-gen-es.mjs) 准备，期望版本取自根目录 `pnpm-workspace.yaml` 的 `catalog`，并要求与 `@bufbuild/protobuf` 相同，安装版本由 pnpm 锁文件固定。所有 TS 使用方的 `@bufbuild/protobuf` 一律写 `"catalog:"`，避免 pnpm 为不同声明装出多份运行库。插件缺失或版本不符时，在仓库根目录执行 `pnpm install --frozen-lockfile`，再次校验通过后使用，不另建缓存。
- 缓存不可执行、版本或平台不符时明确失败，不静默回退到全局工具。未配置的平台直接拒绝，不把其他平台的产物视为可用。
- 各语言使用同一个 protoc；插件使用明确路径，Rust 生成进程显式设置 `PROTOC` 和 `PROTOC_INCLUDE`，不修改全局 PATH 或系统工具安装。

## 修改与升级

调整生成规则时，验证文件选择、递归依赖和错误配置行为，并审查新增及删除的产物。升级工具时同步更新版本、适用的官方校验值与依赖锁文件，重新生成并运行漂移检查及 codec 测试。涉及生成格式或编解码行为变化时，还需核对消费者和兼容边界。

局部环境兼容处理及具体调用参数维护在脚本和代码注释中，不在本文重复登记。

## 编解码与兼容边界

- TS uint64 是 bigint，Rust 是 u64，Go 是 uint64；不要转换为 JS number 保存 ID。
- proto3 optional 不表示 null。需要区分缺失／null／值时，用明确的消息语义表达。
- 兼容新增字段的字节在三端都能解码；Protobuf-ES 和 Go 默认保留未知字段，prost typed decode／encode 会丢弃它们。Gateway 中转层须原样传递字节，只在实际调用与执行端解码。
- 字段编号不可重新分配；删除字段应 reserved 编号与名称。漂移检查检测源码与产物是否同步，不是完整的历史兼容性检查器，也不实现运行时版本协商。
- codec 通过不等于业务合法；长度、权限、领域范围和ID 转换由业务接入层负责。
