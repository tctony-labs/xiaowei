# 实施 Plan

`.agent/plans/` 只保存尚在实施的任务的临时实施计划。创建前，先按 [`../records/README.md`](../records/README.md)，根据需求规模、复杂度和跟踪需要选择开发路径：

- `record + Plans`：用于较大或复杂的需求，record 跟踪整体事项，Plan 跟踪实施切片；仅正在实施的 `active` 事项可以创建实施 Plan。
- `Plan`：用于范围较小、方案明确的需求，直接创建 Plan，不要求 record，也不得为了创建 Plan 或回填结果而擅自新建 record。

两条路径按需求二选一，不以 record 是否存在为分流依据；用户已指定时遵循用户选择。小需求可以直接采用 `Plan`，不必先提议创建 record。

`record + Plans` 路径使用与主文档文件名词干完全一致的目录；`Plan` 路径使用 `YYYY-MM-DD-kebab-case` 任务目录名。Plan 按实施依赖编号：

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

两条路径都可在实施过程中及完成后逐步更新长期文档，不必等到整个事项完成或归档；文档修改遵循根 `AGENTS.md` 的授权规则，同一内容只维护一处。

`record + Plans` 路径中，每份 Plan 实施完成后，应立即将持久信息和验证结果回填对应 active record 的 `How` / `Outcome` 或其链接的独立文档，再删除该 Plan，不等整个事项结束；对应目录为空时一并删除。单个 Plan 完成不等于整个事项完成；事项范围完成且不再有基于原事项的重大改动时，按 record 生命周期向用户提议归档，用户明确发起或确认后核对并补齐长期说明，再归档。事项实施完成或离开 `active` 前不得遗留对应 Plan 目录。

`Plan` 路径中，实施时同步更新相关长期文档；完成后按需补齐根 `docs/` 或对应包文档，向用户报告实施结果与验证结论，再删除已完成的 Plan 和空目录，不为回填结果而擅自新建 record。
