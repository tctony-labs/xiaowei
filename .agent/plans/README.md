# 实施 Plan

`.agent/plans/` 只保存尚在实施的任务的临时实施计划，不要求任务已有 record，不得为了创建 Plan 而擅自新建 record。
已有 record 时，仅 `active` 事项可以创建实施 Plan；完整生命周期和主文档规则见 [`../records/README.md`](../records/README.md)。

已有 record 时使用与主文档文件名词干完全一致的目录；没有 record 时使用 `YYYY-MM-DD-kebab-case` 任务目录名。Plan 按实施依赖编号：

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

已有 record 时，每份 Plan 实施完成后，应立即将持久信息和验证结果回填对应 active record 的 `How` / `Outcome` 或其链接的独立文档，再删除该 Plan，不等整个事项结束。保留 active record，不保留已完成的 Plan；对应目录为空时一并删除。事项实施完成或离开 `active` 前不得遗留对应 Plan 目录。

没有 record 时，按需将长期说明更新到 `docs/` 或已有承载文档，并向用户报告实施结果与验证结论，再删除已完成的 Plan 和空目录；不为回填结果而擅自新建 record。
