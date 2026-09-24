# 01：Pi provider 边界核对

对应 [record](../../records/active/2026-09-24-llm-provider.md)。这是下一步的 provider 边界核对切片。main 模块整理、剪贴板业务归 Rust 及设置能力 Gateway 接入已完成；当前组织约定见 [main README](../../../desktop/src/main/README.md)。

## 范围

只核对旧 Rust provider 请求／事件与 Pi 的模型、输入、输出及取消接口，确认当前 Gateway 能承载的跨语言调用形态。输出下一步可独立验证的最小实现范围。本切片不安装依赖、不新增 crate／npm workspace package、不修改业务契约或产品入口。

## 步骤

1. 已确认 Pi 项目从 `@mariozechner/pi-ai` 改名为 `@earendil-works/pi-ai`；以新包核对公开类型与 DSH 适配层，实施切片再固定具体版本。
2. 核对旧 `ChatRequest`、`StreamEvent`、`LlmMessage` 和 `sampling.rs` 中实际使用的字段，列出 Pi 对应字段、必须转换的字段及暂无法保持的语义。
3. 核对 Gateway Rust→TS 响应流、取消和宿主注册路径，明确 `desktop/src/main/services/llm/`、`app/gateway.ts` 与 Rust caller 的生命周期及最小业务契约。
4. 把映射、偏差、首个可测试实现切片及验证方法回填 record，然后删除本 Plan。

## 完成标准

能说明最小请求与流事件的所有权、传输方向和测试入口；明确真实旧版语义差异。没有把接口调查描述为已完成模型调用。
