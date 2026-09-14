# Coding Agent Skills

`.agent/skills/` 保存本仓库可重复执行的开发与排障流程，不绑定单个开发事项。
事项的理由与结果见 [`../records/README.md`](../records/README.md)。

这里的 Coding Agent skills 面向仓库开发与排障；若项目另有产品运行时 skills，应明确区分，不要混用。

## 目录结构

每个 skill 使用一个 kebab-case 目录，入口固定为 `SKILL.md`：

```text
.agent/skills/
└── inspect-build-toolchain/
    └── SKILL.md
```

## SKILL.md 格式

以 YAML frontmatter 开头，`description` 写明何时使用，便于命中：

```markdown
---
name: inspect-build-toolchain
description: >-
  Diagnose build toolchain and version pinning issues. Use when a build fails on
  toolchain mismatch, or when adding or upgrading a pinned toolchain.
---

# Inspect Build Toolchain

具体入口文件、命令、检查顺序和验证方法。
```

## 维护约束

- Skill 写可执行步骤：入口文件、命令、判定标准、验证方法；架构背景和设计原因写入对应 record；需独立查阅的说明按需提取到 `docs/` 并链接。
- 路径和步骤以当前源码为最终依据；代码入口或验证流程变化时同步更新对应 skill。
- 新增 skill 后，在根 `AGENTS.md` 的 Coding Agent Skills 列表中登记触发条件。
