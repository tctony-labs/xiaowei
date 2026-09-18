# 实施 Plan

`.agent/plans/` 只保存 `.agent/records/active/` 中尚在实施的事项的临时实施计划。
完整生命周期和主文档规则见 [`../records/README.md`](../records/README.md)。

每个事项使用与主文档文件名词干完全一致的目录，并按实施依赖编号：

```text
.agent/records/active/2026-09-08-dynamic-plugin-loader.md
.agent/plans/2026-09-08-dynamic-plugin-loader/
├── 01-loader-baseline.md
└── 02-host-integration.md
```

每份 Plan 应明确：

- 本切片的范围和不包含内容；
- 具体修改文件及其职责；
- 实施顺序和前置依赖；
- 自动验证和必要的人工验收。

Plan 不重复事项的背景、替代方案和长期架构。

每份 Plan 实施完成后，应立即将持久信息和验证结果回填对应 active record 的 `How` / `Outcome` 或其链接的独立文档，再删除该 Plan，不等整个事项结束。保留 active record，不保留已完成的 Plan；对应目录为空时一并删除。事项实施完成或离开 `active` 前不得遗留对应 Plan 目录。
