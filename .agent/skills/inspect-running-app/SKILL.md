---
name: inspect-running-app
description: >-
  通过 XiaoWei 配套 CLI 检查运行实例的窗口、焦点、Dock、模式与有效快捷键，或执行任务已授权的显示／收起操作。适用于工作区开发实例及携带 inspect CLI 的 macOS App。
---

# Inspect Running App

开发环境在目标工作区执行 `just inspect …`。正式 App 使用该安装内 `Contents/Resources/bin/xiaowei-inspect` 的绝对路径；有空格时引用路径。后续沿用同一入口，不改用另一份 PATH 命令或扫描其他 socket。

1. 执行 `just inspect identify --json` 和 `just inspect status --json`，核对响应的 `source.kind`、规范绝对 `source.path`、PID 与实例 ID。正式 App 使用相同命令参数，替换为其 CLI 绝对路径。共享数据路径不能证明实例归属。
2. 用 `capabilities --json` 获取运行实例实际支持的方法、参数与 `mutates`。按需读取 `windows --json`、`shortcuts --json`；隐藏窗口不需要先唤起。JSON 响应的业务结果在 `result`。
3. 只在当前任务授权范围内执行 `show quick-chat`、`show search`、`show clipboard` 或 `hide`。重复 show 保持显示。首版操作只覆盖 Launcher，不打开设置或调用任意 RPC。
4. 检查返回的实际窗口、焦点和 Dock 状态。`hide` 返回的 `focusRestored` 分别表示已归还、未归还或无需归还（null）。Dock 的 deferred／pending 不是最终结果；必要时在五秒内有界复查，超时后报告未确认状态，不盲目重放操作。视觉效果、文字和输入法仍需原生 UI 验收。

CLI 自动按代码来源配对，App 在执行前再次校验完整来源。错误应区分未运行、来源／协议错配、参数错误、宿主失败与超时。连接失败时按 [manage-dev-instances](../manage-dev-instances/SKILL.md) 检查实际进程；不冷启动 App、不改连其他来源，也不读写共享数据库来替代检查。

`--help` 与 `--version` 可离线读取。开发实例加载改动或重启前，仍需按实例技能核对进程路径、cwd、父子关系及 console；CLI 的身份结果不替代重启归属检查。

命令与二进制位置见 [CLI README](../../../desktop/inspect/README.md)，协议、字段与错误见 [本地协议](../../../desktop/inspect/docs/protocol.md)。
