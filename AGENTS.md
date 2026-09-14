# XiaoWei

## Project Info

长期说明默认维护在 `.agent/records/active/` 对应事项的 `How` 中；跨多个事项或需要独立查阅的说明，按需提取到 `docs/`，不强制创建该目录。提取后，record 保留理由、取舍和结果，并链接独立文档，避免重复维护。实际架构和行为以当前代码为最终依据；修改模块时，应同步更新承载对应说明的 record 或独立文档。

## Coding Agent Skills

仓库开发与排障流程位于 `.agent/skills/`，约定见 [`.agent/skills/README.md`](.agent/skills/README.md)。命中对应任务时，先完整读取该 `SKILL.md`。当前尚未登记 skill。

## Development records

开始非平凡开发事项前，先完整读取 [`.agent/records/README.md`](.agent/records/README.md)，并遵循其中的事项生命周期。理由、取舍和结果维护在 `.agent/records/`，active 事项的 `How` 默认兼作当前有效的长期说明，按需提取独立文档；临时实施步骤维护在 `.agent/plans/`。只有正在实施的 active 事项可以拥有 Plan。事项实施完成或离开 active 时，必须回填 Outcome 和长期文档，并删除对应 Plan。实施完成且成果仍在生效的事项继续留在 active。
