# 02g：文件工具与实际权限闭环

前置：[02f](02f-interactions.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：Read／Write／Edit／Glob／Grep 在会话 workspace 中实际可用，授权范围与工具结果正确。

范围边界：不操作用户文件；不加入 Bash、网页搜索或应用专属工具。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-agent-runtime/src/tools/filesystem/mod.rs、file.rs` | 迁移五种工具、路径／参数校验、输出限额与真实读写 |
| 修改 | `crates/xw-agent-runtime/src/tools/mod.rs、permission.rs`、`crates/xw-agent/src/context.rs` | 导出文件工具、复用会话权限范围，提示只描述实际工具 |
| 修改 | `crates/xw-agent/src/tool_registry.rs`、`crates/xw-agent-types/src/rollout.rs`、`contracts/proto/xiaowei/agent.proto` | 注册文件工具；创建接口与 SessionHeader 增加可选 cwd，创建后默认不变，工具 RunContext 使用该目录；有效决定授予的范围从历史重建 |
| 新增 | `crates/xw-agent-runtime/tests/filesystem.rs` | 临时目录真实读写／搜索与授权范围测试 |
| 修改 | `crates/xw-agent/tests/tool_loop.rs` | 真实文件工具 → 结果 → 后续生成，停止和未知结果的基础关联 |
| 修改 | `Cargo.lock` | 按旧实现迁移实际依赖 |

## 实施顺序

1. 完整核对旧 filesystem/file.rs，保留读写语义、输出截断／搜索限制，权限检查与业务逻辑分别验证。
2. 工作区外写入必须有有效权限决定，处理 symlink／路径规范化；不能因本片测试方便更改授权规则。

## 独立验收

- 临时 workspace 实际执行五种工具，覆盖不存在、非法参数、输出限额、拒绝／允许和取消。
- runtime／xw-agent 测试、相关格式／check；重建受影响正式 Agent addon。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
