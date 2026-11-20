---
name: inspect-running-app
description: >-
  通过 XiaoWei 配套 CLI 检查运行实例的窗口、焦点、Dock、模式与有效快捷键，或执行任务已授权的显示、收起和置顶操作。适用于工作区开发实例及携带 inspect CLI 的 macOS App。
---

# Inspect Running App

开发环境在目标工作区执行 `just inspect …`。正式 App 使用该安装内 `Contents/Resources/bin/xiaowei-inspect` 的绝对路径；有空格时引用路径。后续沿用同一入口，不改用另一份 PATH 命令或扫描其他 socket。

1. 执行 `just inspect identify --json` 和 `just inspect status --json`，核对响应的 `source.kind`、规范绝对 `source.path`、PID 与实例 ID。正式 App 使用相同命令参数，替换为其 CLI 绝对路径。共享数据路径不能证明实例归属。
2. 用 `capabilities --json` 获取运行实例实际支持的方法、参数与 `mutates`。按需读取 `windows --json`、`shortcuts --json`；隐藏窗口不需要先唤起。JSON 响应的业务结果在 `result`。
3. 要操作 Launcher 且工具可能切走焦点时，先确认能力列表包含 `launcher.setPinned`，并记录 `result.state.launcher.pinned`。如果尚未置顶，先执行 `pin --json` 并确认返回的 `pinned` 为 `true`，再用 `show search`、`show clipboard` 或 `show quick-chat` 显示目标模式。隐藏时也能设置图钉，`pin` 自身不唤起窗口。`windows` 里的 `alwaysOnTop` 是原生层级，判断用户图钉状态时使用 `state.launcher.pinned`。
4. 完成操作后，通过 `unpin --json` 恢复本次临时开启的置顶，或按任务要求保留。需要主动收起时使用 `hide`，并检查 `focusRestored`（已归还、未归还或无需归还）。重复 `show` 保持显示。操作范围限 Launcher，视觉效果、文字和输入法仍需原生 UI 验收。
5. 检查返回的实际窗口、焦点和 Dock 状态。Dock 状态延后或更新中时可在五秒内复查，超时后报告未确认状态。写操作超时后先查询实际状态，再决定是否重试。

CLI 自动按代码来源配对，App 在执行前再次校验完整来源。错误应区分未运行、来源／协议错配、参数错误、宿主失败与超时。连接失败时按 [manage-dev-instances](../manage-dev-instances/SKILL.md) 检查实际进程；确需冷启动开发版桌面 App 时，按该技能的桌面冷启动流程取得用户明确授权。不改连其他来源，也不读写共享数据库来替代检查。

`--help` 与 `--version` 可离线读取。开发实例加载改动或重启前，仍需按实例技能核对进程路径、cwd、父子关系及 console；CLI 的身份结果不替代重启归属检查。

命令与二进制位置见 [CLI README](../../../desktop/inspect/README.md)，协议、字段与错误见 [本地协议](../../../desktop/inspect/docs/protocol.md)。
