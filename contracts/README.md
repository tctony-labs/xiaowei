# Protobuf 契约

`proto/` 是消息和接口的唯一手写来源。TS、Rust、Go 包只提供消息、codec 和接口描述，不依赖 Gateway、Electron、napi 或 gRPC。

## 组织与消费

- [`proto/xiaowei/`](proto/xiaowei/README.md)：业务契约与设计规则；具体字段、方法语义写在 proto 注释中。
- [`proto/testing/`](proto/testing/)：生成、编解码和传输验证使用的独立测试契约，不向产品注册。
- [`ts/`](ts/)：npm 包 `xiaowei-contracts`，workspace 消费者添加 `"xiaowei-contracts": "workspace:*"`。入口导出消息和 service descriptor；使用方须支持 TS 源码及 enum 转译。
- [`rust/`](rust/)：crate `xw-contracts`，通过 Cargo path 依赖消费。`FILE_DESCRIPTOR_SET` 提供文件／服务／方法描述，`prost::Name` 提供消息全名。消费已入库产物无需 protoc。
- [`go/`](go/)：module `github.com/tctony-labs/xiaowei/contracts/go`。本地消费者在自己的 go.mod 中 require，并用 replace 指向该目录；不复制生成文件，不要求根 go.work。
- [`tools/`](tools/)：生成时使用的 Rust codegen，不是契约运行依赖。

## 生成与检查

安装工作区依赖后，从仓库根目录运行：

```sh
just gen
pnpm contracts:check
pnpm contracts:test
```

`just gen` 先生成语言契约和 descriptor，再生成 Gateway Rust 绑定。`contracts:check` 在临时目录重建并比较文件集合与内容，不改写源码或产物；`contracts:test` 验证生成规则和三语言 codec，不启动桌面或读取用户数据。

[`generate.config.json`](generate.config.json) 按语言选择入口，路径相对于 `proto/`，支持文件名和 glob，并自动包含项目内递归 import。三个语言键必须显式配置；空数组关闭该语言生成，非空规则无匹配则失败。本地业务默认生成 TS／Rust，Go 仅加入服务端实际需要的契约。

产物 `ts/src/gen/`、`rust/src/gen/` 和 `go/gen/` 全部入库，禁止手改。新增 TS 文件或 Rust package 时同步维护公共入口导出。具体修改步骤见 [维护 Gateway 业务契约](../.agent/skills/maintain-gateway-contract/SKILL.md)。

生成需要 curl、unzip、Node／pnpm、Cargo 和 Go，首次下载需要网络。固定工具版本、缓存、平台支持和语言路径映射见 [契约生成机制](../docs/contracts-generation.md)。

## 编解码与兼容边界

- TS uint64 是 bigint，Rust 是 u64，Go 是 uint64；不要转换为 JS number 保存 ID。
- proto3 optional 不表示 null。需要区分缺失／null／值时，用明确的消息语义表达。
- 兼容新增字段的字节在三端都能解码；Protobuf-ES 和 Go 默认保留未知字段，prost typed decode／encode 会丢弃它们。Gateway 中转层须原样传递字节，只在实际调用与执行端解码。
- 字段编号不可重新分配；删除字段应 reserved 编号与名称。漂移检查检测源码与产物是否同步，不是完整的历史兼容性检查器，也不实现运行时版本协商。
- codec 通过不等于业务合法；长度、权限、领域范围和ID 转换由业务接入层负责。
