# 开发事项生命周期

`.agent/records/` 保存非平凡开发事项的理由、目标、关键取舍、当前进展和最终结果。默认由 active 事项的 `How` 同时承载当前有效的设计、行为和约束，无需另建 `docs/`。记录不充当逐日开发日志；背景、替代方案和实施结果应与当前说明分开。

## 何时创建事项

满足以下任一条件时创建事项主文档：

- 改变架构、模块边界、依赖方向或跨进程协议；
- 改变持久化、安全边界、外部契约或发布方式；
- 存在需要记录的替代方案和长期取舍；
- 需要多个可独立验证的实施切片。

局部 bug 修复、机械重构、文案修改，以及已有 Coding Agent Skill 完整覆盖的例行操作通常
不创建事项。任务在实施中显著扩大到上述范围时，再补建事项。

## 目录与状态

```text
.agent/records/
├── proposed/
├── active/
└── archived/
```

目录是状态的唯一权威，正文不维护容易漂移的 `Status` 字段：

- `proposed`：正在明确问题、范围和方案，尚未承诺实施；不得创建实施 Plan。
- `active`：已决定推进且尚未被放弃、移除或取代；
  可以正在实施，也可以已经交付并正在生效。只有尚有实施工作时才按需创建 Plan。
- `archived`：事项被拒绝、放弃、移除、弃用或取代；`Outcome` 必须说明原因，
  取代时链接后继事项。

常规生命周期为：

```text
proposed → active
proposed → archived  # rejected
active   → archived  # abandoned / removed / deprecated / superseded
```

实施完成不会使事项离开 `active`；只要已交付的决策和成果仍在生效，
主文档就继续留在 `active`。事项归档后重新产生工作时通常创建新的主文档并引用旧事项；
只有原事项当初不应归档时，才将其移回 `active`。

## 命名与移动

- 文件名使用稳定的 `YYYY-MM-DD-kebab-case.md`，日期取事项首次记录日期。
- 状态迁移只移动目录，不修改文件名。
- 移动文档时，在同一次修改中更新所有入站链接。
- 实施 Plan 目录必须使用主文档的完整文件名词干。

例如：

```text
.agent/records/active/2026-09-08-dynamic-plugin-loader.md
.agent/plans/2026-09-08-dynamic-plugin-loader/01-loader-baseline.md
```

## 主文档内容

按事项需要使用以下章节，不需要为空章节保留占位：

```text
Why
What
How
Alternatives considered
Current work
Outcome
```

- `Why`：问题、背景和触发条件。
- `What`：目标、范围、非目标和完成标准。
- `How`：方案、边界和约束；active 事项默认在此维护当前有效的设计、行为、接口和必要的运维说明。尚未实现的方案应明确标注，避免被当作当前行为；已提取到独立文档的说明只保留链接，不重复维护。
- `Alternatives considered`：确实评估过的方案及未采用原因。
- `Current work`：只在 `proposed` 或尚未完成实施的 `active` 事项中使用，
  覆盖更新进展、阻塞和下一步。
- `Outcome`：实施完成或进入 `archived` 前填写实际结果、偏差、
  验证证据和后续事项。

## 实施 Plan

只有正在实施的 `active` 事项可以在 `.agent/plans/<initiative-stem>/` 下创建
Plan。每份 Plan 只覆盖一个可独立验证的实施切片，记录具体文件、执行顺序和验证方法；
不要重复主文档中的背景、方案讨论或长期架构说明。简单事项可以不创建 Plan。

每份 Plan 完成后，应立即把新增的持久决定、实现偏差和验证结论回填主文档的 `How` / `Outcome` 或对应独立文档，再删除
该 Plan；不要等整个事项完成后统一清理。

## 生命周期检查

### 进入 active

- Why、范围、非目标和完成标准已经足够明确；
- 关键方案已决定，未决问题不会改变实施方向；
- 如需 Plan，目录名与事项文件名词干一致。

### 实施完成

- 约定范围已经实现并验证；
- 当前行为、接口和运维方式已经更新到 active record 的 `How` 或对应独立文档；不要求另建 `docs/`；
- `Outcome` 已记录实际结果、偏差、验证证据和明确拆出的后续事项；
- 对应 `.agent/plans/<initiative-stem>/` 已删除；
- 主文档继续位于 `active`。

若必要验收仍属于当前范围，事项仍在实施中。只有明确收窄范围，
并把剩余工作拆成独立后续事项时，才能按收窄后的范围记录实施完成。

### 进入 archived

- `Outcome` 已说明 rejected、abandoned、removed、deprecated 或
  superseded 的原因；
- 被取代的事项已链接后继事项；
- 对应实施 Plan 已删除；
- 所有入站链接已更新。

## 与其他文档的边界

- `.agent/records/`：事项的理由、取舍、进度和结果；active 事项的 `How` 默认兼作当前有效的长期说明。
- `docs/`（可选）：跨多个事项或需要独立查阅的架构、接口、部署等说明。提取后，record 保留理由、取舍和结果，并链接独立文档，避免两边重复维护。
- `.agent/plans/`：活动事项的临时实施步骤，完成后删除。
- `.agent/skills/`：可重复执行的仓库开发与排障流程，不绑定单个事项。

后续事项改变已有行为时，同步更新承载该说明的 active record 或独立文档；不要让多个 active record 留下相互矛盾的当前说明。原事项整体被取代时，按归档规则处理并链接后继事项。

完成事项时，Git 历史保存被删除 Plan 的执行细节；不要为了保留历史而让已完成 Plan 留在
工作树中。
