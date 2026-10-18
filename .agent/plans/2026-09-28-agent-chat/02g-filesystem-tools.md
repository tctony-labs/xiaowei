# 02g：文件工具与实际权限闭环

前置：第一阶段接 [02e](02e-tool-loop.md)，第二阶段接 [02h 前台 Bash](02h-bash-sandbox.md)完成；交互工具不再作为文件工具的前置。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md#内置工具接入批次)。

本片结果：Read／Write／Edit／Glob／Grep 在会话 workspace 中实际可用，授权范围与工具结果正确。

范围边界：不操作用户文件；不加入 Bash、网页搜索或应用专属工具。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-agent-runtime/src/tools/filesystem/mod.rs、file.rs` | 迁移五种工具、路径／参数校验、输出限额与真实读写 |
| 新增 | `crates/xw-agent-runtime/src/permission.rs` | 迁移基础权限检查；尚未接入权限申请时不开放需要额外授权的操作 |
| 修改 | `crates/xw-agent-runtime/src/tools/mod.rs`、`crates/xw-agent/src/context.rs` | 分批导出文件工具、复用会话权限范围，提示只描述实际工具 |
| 修改 | `crates/xw-agent/src/tool_registry.rs`、`crates/xw-agent-types/src/rollout.rs`、`contracts/proto/xiaowei/agent.proto` | 注册文件工具；创建接口与 SessionHeader 增加可选 cwd，创建后默认不变，工具 RunContext 使用该目录；有效决定授予的范围从历史重建 |
| 新增 | `crates/xw-agent-runtime/tests/filesystem.rs` | 临时目录真实读写／搜索与授权范围测试 |
| 修改 | `crates/xw-agent/tests/tool_loop.rs` | 真实文件工具 → 结果 → 后续生成，停止和未知结果的基础关联 |
| 修改 | `Cargo.lock` | 按旧实现迁移实际依赖 |

## 实施顺序

1. 第一阶段为工具第 1 批：Read／Write／Edit 一起实现与验收，不提前注册 Glob／Grep。完整核对旧 filesystem/file.rs，保留读写语义和输出截断，权限检查与业务逻辑分别验证。
2. 工作区外写入必须有有效权限决定，处理 symlink／路径规范化；RequestPermission 接入前，没有所需有效决定的操作返回权限不足，不临时放开，也不隐式引入交互工具。
3. 第一阶段完成后推进第 2 批前台 Bash，再返回本计划实施第二阶段，即第 3 批 Glob／Grep；二者一起实现与验收，核对旧搜索限制与输出语义。
4. 第一阶段完成即回填 record，删除本计划已完成的实施步骤，保留第二阶段；全部完成后删除本计划。第 4 批再接权限申请及有效决定消费。

## 独立验收

- 第一阶段用临时 workspace 实际验证 Read／Write／Edit 的调用→结果→继续生成，以及不存在、非法参数、输出限额、权限边界和取消；第二阶段分别验证 Glob／Grep 的真实搜索及边界，整批通过后才进入下一批。
- runtime／xw-agent 测试、相关格式／check；重建受影响正式 Agent addon。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
