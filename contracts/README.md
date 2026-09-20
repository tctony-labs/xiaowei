# Protobuf 契约

`proto/` 是消息和接口的唯一手写来源。TS、Rust、Go 包只包含消息、codec 和接口描述，不依赖 Gateway、Electron、napi 或 gRPC。`testing` 用于编解码和传输测试；`xiaowei.common`、`xiaowei.search`、`xiaowei.launcher`、`xiaowei.app`、`xiaowei.system`、`xiaowei.clipboard` 描述现有桌面业务。

业务职责划分、消息设计与修改流程见 [业务契约原则](proto/xiaowei/README.md)。

## 组织与消费

- `proto/testing/fixture.proto`：通用生成与编解码测试，使用独立的 `testing` package，不归属业务项目。
- `proto/xiaowei/{common,search,launcher,app,system,clipboard}.proto`：小规模业务按文件组织，package 为 `xiaowei.<业务>`，本地协议不预设 `v1`。common 目前仅保留 Empty；业务消息使用具名字段，不按标量类型抽象通用包装。
- `ts/`：npm 包 `xiaowei-contracts`，workspace 消费者添加 `"xiaowei-contracts": "workspace:*"`。入口导出生成的消息及 service descriptor；使用方须支持 TS 源码和 enum 转译（项目 bundler 支持，测试使用固定的 tsx 4.23.13）。
- `rust/`：crate `xw-contracts`，通过 Cargo path 依赖消费。`testing` 模块导出测试消息，`FILE_DESCRIPTOR_SET` 提供 protoc 原生文件／服务／方法描述；`prost::Name` 提供消息全名。新增 namespace 后在 `src/lib.rs` 显式导出对应模块。
- `go/`：独立 module `github.com/tctony-labs/xiaowei/contracts/go`。本地 Go 消费者在自己的 go.mod 中 require 该 module，并用 `replace github.com/tctony-labs/xiaowei/contracts/go => ../contracts/go` 指向它（相对路径按消费者位置调整）；不复制生成文件，不要求根 go.work。当前 server 尚未消费它，因此不修改 server/go.mod。
- `tools/`：仅生成时运行的 `xw-contracts-codegen`，调用 prost-build；不是契约运行依赖。没有 build.rs，消费已入库的 Rust 产物无需 protoc。

测试 service `Fixture` 与 `PeerFixture` 复用相同消息，供独立 owner 双向调用验证。两者的 Echo 为 unary，Watch 为 server-streaming；Changed 的 message full name 是候选事件名称。这里只定义与读取描述，没有实际调用、事件订阅或流运行时，也没有 Gateway client／handler 绑定。

## 按语言选择 proto

`generate.config.json` 按语言声明入口，路径相对于 `contracts/proto/`，支持精确文件名和 glob：

```json
{
  "ts": ["**/*.proto"],
  "rust": ["**/*.proto"],
  "go": ["testing/fixture.proto"]
}
```

当前测试定义位于 `proto/testing/fixture.proto`，为了三语言 codec 验证显式列入 Go。新增本地业务默认仅生成 TS／Rust；服务端通信契约需在 go 数组中显式添加文件或目录规则，例如 `xiaowei/server/**/*.proto`（目录实际存在后再添加）。不要求所有服务端契约集中在一个目录。

生成器先调用 protoc 读取原生 FileDescriptorSet，再为每种语言选择入口及其递归依赖的项目内 proto，包括 public import。依赖的 common 类型会一并生成；官方 well-known types 由语言运行库提供，不额外生成。生成顺序排序去重，TS、Rust、Go 分别执行生成。

Go 生成目录为 `go/gen/<proto 相对目录>/`。生成器读取 `go/go.mod` 的 module，通过 protoc 的 `M文件=import路径` 参数统一指定所有选中项目 proto 的 Go 路径（覆盖 proto 内的 go_package）；测试 proto 因而无需写死项目 module，跨文件 import 也使用同一映射。官方 well-known types 保持运行库路径。

复制到其他项目时，保留 `proto/testing/`，把业务目录 `proto/xiaowei/` 换成目标项目目录，按需更新 Go 的业务入口规则即可；TS／Rust 的 `**/*.proto` 无需修改，生成脚本及测试定义不依赖业务目录名称。当前 npm／Cargo 包名与 Go module 是工程接入标识，可以保留；若目标项目需要重命名，须同步对应清单与消费者 import，并将契约包接入目标 workspace。

三个语言键必须显式配置。空数组关闭该语言的生成；非空规则匹配不到文件时直接失败，避免规则拼写错误导致产物被清空。当前测试依赖三语言 fixture，关闭它的生成后需同时调整消费者和测试。

generate 与 check 使用同一配置：配置缩小范围后，check 只报告多余的旧产物，generate 才移除该语言不再需要的产物。`pnpm contracts:test` 同时验证文件选择、递归依赖、空配置及错误配置。

## 工具链与生成

安装工作区依赖后，在仓库根目录运行：

```sh
just gen
pnpm contracts:check
pnpm contracts:test
```

`just gen` 当前调用 `pnpm contracts:generate`，后续可统一加入其他生成任务。

固定工具：protoc **36.2**、Protobuf-ES **2.15.0**、prost／prost-build **0.14.4**、protoc-gen-go／Go protobuf runtime **v1.36.6**。依赖由 pnpm-lock.yaml、Cargo.lock 和 contracts/go/go.sum 锁定。生成脚本不依赖忽略的 experiments 目录。

`protoc.mjs` 从官方 release 下载当前平台安装包，按仓库固定的 SHA-256 验证后原子安装到 `~/.cache/protoc/36.2/`。同机其他项目可复用同版本目录；不带项目名或架构后缀。安装元数据记录平台与下载包摘要，加载时检查元数据、可执行版本和 include 目录。缓存属于当前机器，不能跨架构同步。当前配置 macOS／Linux 的 arm64／x64 下载，实际仅在 macOS arm64 验证；Windows 生成入口尚未适配。

生成依赖 curl、unzip、Node／pnpm、Cargo 和 Go。首次下载需网络；Go 插件由 `protoc-gen-go.mjs` 管理，首次通过固定版本的 go install 安装到共享缓存 `~/.cache/protoc-gen-go/v1.36.6/bin/protoc-gen-go`：仅在安装子进程设置临时 GOBIN，校验版本后原子移入版本目录。后续先校验版本再直接通过绝对路径使用，不重复 go install，不覆盖全局插件；同版本跨项目复用，不同版本并存。缓存不可执行或版本不符时明确失败，不回退全局插件。生成产物与漂移比较仍使用独立临时目录。Protobuf-ES 使用项目内的插件绝对路径，仅对该生成子进程禁用 Node Web Storage，避免其间接依赖 @typescript/vfs 探测 localStorage 时触发实验性警告；不屏蔽其他 Node 警告。Rust 生成子进程的 PROTOC 与 PROTOC_INCLUDE 显式指向共享缓存，所有语言使用同一个编译器，不修改全局 PATH 或 Homebrew。

产物为 `ts/src/gen/`、`rust/src/gen/`（含 descriptor.bin）和 `go/gen/`，全部入库，禁止手改。TS 生成目录排除 Biome 检查，保留官方生成格式。手写 proto 变更后运行 generate 并审查产物差异；新增 TS 文件也需维护公共入口导出。

check 在临时目录完整重建，对文件集合和字节内容进行比较；缺失、多余或陈旧文件会失败。它允许更新工具／构建缓存，但不修改源码、生成产物或暂存区。check 已接入 pnpm check／just check；codec 测试已接入 just test。版本升级须更新仓库中的版本／官方校验值、重新生成并验证，不会自动跟随 latest。

## 编解码与兼容边界

测试消费者通过各语言包的公开入口读取消息和接口描述。`pnpm contracts:test` 编译独立 Rust／Go codec 可执行程序，再由 TS 测试执行双向跨语言链路。只交换测试 PB 字节，不启动桌面、不读用户数据、不注册网络服务。

覆盖 Unicode、超过 JS 安全整数范围及 uint64 最大值、optional 缺失与显式空字符串、oneof 缺失／null／字符串、嵌套 bytes（含 2 MiB 数据）、非法 wire、字段编号及 reserved 描述、unary／event／server-streaming 名称和类型。

- TS uint64 是 bigint，Rust 是 u64，Go 是 uint64；不要转换为 JS number 保存 ID。
- proto3 optional 不表示 null。本测试用 oneof 与枚举显式表达缺失／null／值，未另造类型系统。
- 兼容新增字段的字节在三端都能解码；Protobuf-ES 和 Go 默认保留未知字段，prost typed decode／encode 会丢弃它们。Gateway 中转层须原样传递字节，只在实际调用与执行端解码。
- 字段编号不可重新分配；删除字段应 reserved 编号与名称。漂移检查检测源码与产物是否同步，不是完整的历史兼容性检查器，也不实现运行时版本协商。
- codec 通过不等于业务合法；长度、权限、领域范围和业务 facade 的 ID 转换在后续接入层完成。
