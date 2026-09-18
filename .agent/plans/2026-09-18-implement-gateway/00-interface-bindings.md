# 00：Protobuf 契约生成和测试

主事项：[实现核心 Gateway 通信机制](../../records/active/2026-09-18-implement-gateway.md)。本 Plan 的范围已由用户确认定稿，尚未实施完成；独立 TS／Rust 适配探针的结论见主 record。

## 范围

只建立 proto 组织、TS／Rust／Go 消息及接口描述生成、生成检查和编解码测试。不实现 Gateway client／handler 绑定、registry、运行时控制协议或真实业务接入。通用调用绑定机制在 Plan 01 实现，stream runtime 在 Plan 03，业务在 Plan 04 接入。

## 文件与职责

- `contracts/proto/xiaowei/common/`：真正共用且语义一致的消息，业务可依赖 common，common 不反向依赖业务；不预先堆通用类型。
- `contracts/proto/xiaowei/<业务>/`：按业务组织文件，规模小时不强制拆 types／service／events。本地 proto 不加 `v1`；后续涉及服务端的契约再根据兼容需求决定版本命名空间。
- 测试 fixture：独立测试 namespace，声明 unary、event message 和 server-streaming 接口，本切片用于生成及 codec 验证，后续由 Plan 01 复用以验证 Gateway 核心，不注册生产服务；实际业务 proto 在 Plan 04 迁入。
- `contracts/ts/`、`contracts/rust/`、`contracts/go/`：三个语言契约包，集中保存生成类型、codec 与接口描述，不依赖 Gateway。业务目录不是单独的语言包。
- `contracts/` 下的生成工具和配置：编排 protoc、Protobuf-ES、prost／prost-build、官方 protoc-gen-go；固定公开工具版本，不自研类型 DSL 或 codec。
- workspace／module 配置：纳入 TS／Rust 契约包，明确 Go module 的本地依赖方式；业务消费方依赖包，不复制生成代码。
- 根 scripts：`contracts:generate` 与只读 `contracts:check`，后者接入现有检查。

## 实施步骤

1. 建立上述目录和测试 proto，确认 proto package 与目录一致；为三语言包明确包名／module path 及导出入口。
2. 生成消息类型、codec 和接口描述，包括 service／method 名、请求／响应类型和 server-streaming 标记。Rust 可使用 descriptor set 等原生生成能力；这里不生成依赖 Gateway 的 client／handler adapter。
3. 验证 optional、oneof、嵌套 bytes、64 位整数、未知字段及 null 表达；保留 PB 原生语义，不自定义另一套类型系统。业务校验和 ID facade 转换不在本切片实现。
4. 建立确定性生成、产物入库和漂移检查；检查在临时目录重建比较，不改源码、不自动暂存。生成产物禁止手改；不依赖被忽略的 experiments 目录。
5. 建立 TS／Rust／Go 独立消费者编译和跨语言 codec fixture。检查字段编号、reserved 和兼容加字段；不实现 Gateway 运行时版本协商或 route 检查。

## 验证与完成标准

- 三语言消费者能独立引用契约包，消息与 service descriptor 一致；没有 Gateway／Electron／napi／网络运行时依赖。
- 三语言编码解码覆盖 Unicode、uint64、optional、oneof、嵌套 bytes 和非法 wire；明确未知字段保留差异，不能把编解码通过等同于业务输入合法。
- unary／event message／server-streaming 描述能从生成产物读取；没有实际调用、订阅或开流。
- 连续两次生成无差异；陈旧／缺失产物检查失败且不修改工作树。
- 本地 package／目录无预设 v1；服务端版本策略尚不在本切片确定。
- 完成后回填主 record 并删除本 Plan。当前“定稿”只表示计划范围已确认，不代表实施完成。
