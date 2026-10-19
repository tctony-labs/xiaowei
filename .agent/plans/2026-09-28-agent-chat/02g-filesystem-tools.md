# 02g：Glob／Grep 文件搜索

前置：完成第 2 批[前台 Bash](02h-bash-sandbox.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与[工具批次](00-implementation-order.md#内置工具接入批次)。第一阶段 Read／Write／Edit、cwd 和基础权限已实现，行为及证据见[交付结果](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18)，联合批次产品验收已通过。PDF 留作后续，不扩展本批。

## 文件与步骤

1. 核对旧版 filesystem 搜索实现及依赖，整体迁移 Glob／Grep 的路径、忽略规则、输出截断、排序和错误语义，不只对齐名称。
2. 扩展 `crates/xw-agent-runtime/src/tools/` 的声明和真实执行，复用既有 cwd／permission 路径处理；在 `crates/xw-agent/src/tool_registry.rs` 同步模型可见与执行集合，只加入本批工具及规则。
3. 扩展 `crates/xw-agent-runtime/tests/filesystem.rs` 与 `crates/xw-agent/tests/tool_loop.rs`，覆盖真实临时目录搜索、匹配／无匹配、非法参数、输出限额及后续生成。实际需要依赖时才改 Cargo 配置和锁文件。

## 验收

- Glob／Grep 整批使用真实临时文件，结果和权限边界符合旧版已核对语义；未知／未开放工具仍不能执行。
- 相关 Rust 测试、严格 Clippy、正式 Agent addon 重建和 just check；正式模型从产品入口完成搜索 → 结果 → 后续生成。
- 回填 record 的实际行为／差异及证据后删除本 Plan，更新后继引用。
