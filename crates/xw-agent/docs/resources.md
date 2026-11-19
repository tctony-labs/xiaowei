# Agent 规则与命令资源

AGENTS.md、rules/*.md 自动进入系统上下文；commands/*.md 先提供名称／简介目录，由模型根据自然语言请求调用 Command 加载正文。当前不提供 slash 入口。

## 资源位置

root 是宿主传入的 Agent 根目录，desktop 默认 ~/.xiaowei，支持绝对路径环境变量 XIAOWEI_AGENT_HOME，不附加 agent/。cwd 是创建会话时保存的工作目录，持久 Quick Chat 默认在 root/quick-chat/<session-id>/。无 root 的内存服务仅加载项目资源。

| 资源 | 用户级 | 项目级 |
| --- | --- | --- |
| 顶层规则 | `<root>/AGENTS.md` | `<cwd>/AGENTS.md` |
| 规则目录 | `<root>/rules/*.md` | `<cwd>/.xiaowei/rules/*.md` |
| 命令目录 | `<root>/commands/*.md` | `<cwd>/.xiaowei/commands/*.md` |

只扫描约定位置，不递归 rules／commands 子目录，不向 cwd 祖先搜索，不按文件读取位置加载嵌套规则。XiaoWei.md／CLAUDE.md 不会自动发现。

## 规则与优先级

每个作用域先加载 AGENTS.md，再按文件名升序加载 rules 下的直接 .md 文件。用户规则在前，项目规则在后，冲突时项目优先；同名规则都会保留。

AGENTS.md 全文去除首尾空白后如果仅为 `@相对路径`，则读取目标文件；路径相对当前文件父目录解析，支持连续重定向，以 canonical 路径防环和同一作用域去重。rules/*.md 中的 @xxx 是普通正文。

每个文件对应稳定片段，例如 `rules.user.AGENTS.md`、`rules.project.rules/style.md`。正文包含实际来源路径，相对引用基于该文件目录。`rules.index` 显式记录清单、顺序和作用域优先级，不依赖 map 遍历顺序。空文件不产生规则片段。

## 缓存与更新

每个新 Run 在阻塞池枚举目录，检查文件的 canonical 目标路径、mtime 和 size。未变时复用缓存正文及命令解析结果，新增／变化才读取，删除后移除。重定向链各目标也检查，symlink 改向可以发现。缓存仅在 Session 内存，重开首次重新读取。

Run 内固定快照，磁盘变化从下一 Run 生效。touch 或重写相同正文可能触发读取，但内容相同不追加系统记录。mtime＋size 不保证识别刻意保留元信息的等长改写。

缺失文件／目录视为空资源。不可读、非 UTF-8、重定向循环、命令名称或 YAML 非法时记录安全警告并跳过，不保留旧内容作为当前资源；失败不缓存，下次 Run 可重试。没有 watcher 或额外后台扫描任务；不改变既有 Skill 扫描方式。

规则及 commands.catalog 复用 SystemContext：首次基线、变化增量、无变化不追加。修改发送该片段的新完整正文，**不是逐行 diff**；删除撤销片段，清单变化同步更新 rules.index。候选更新超出现有模型历史预算时，在提交上下文或接纳输入前拒绝，不截断后声称成功加载。

更新经 LLM PB system_context 和 Pi system sections，在已接入的 Responses／Completions 中成为 system 或 developer 消息：`Updated system prompt section "片段名":` 后跟新正文，或 `Removed system prompt section "片段名".`。旧基线保留在历史，更新保留发生的位置；其他 provider 遇到实际增量仍沿用既有拒绝规则。不重复追加不等于不传历史，也不保证网络传输或 token 免费。

## 自然语言调用命令

命令名来自文件名，例如 commands/weekly.md 对应 weekly。名称支持中文，不能包含空白、控制字符或路径分隔符。同名时项目命令覆盖用户命令。

```markdown
---
description: 按模块整理本周提交。
---
读取当前项目本周的提交，按模块归纳变更并说明验证情况。
```

YAML frontmatter 可选，只取 description，正文不包含 frontmatter。无简介仍按名称列出，空正文不进入目录。用户可说“请按 weekly 命令整理本周变更”，模型从 commands.catalog 发现模板后调用固定 schema 的 `Command(name: string)`，名称不写入枚举。

工具从当前 Run 快照返回名称、来源、完整正文及 metadata_json.command 的 name／path／hash，只加载模板。引用文件通过 Read，脚本通过 Bash 按现有授权执行，不增加权限。正文仅服务当前任务，不是常驻系统规则；新任务再次使用应重新加载，不把历史结果当作当前版本。

未知名称或非法参数产生工具错误。完整输出超过文件工具现有 64 KiB 上限时拒绝加载，不静默截断。无 cwd 的纯文本会话不提供 Command；有 cwd 的会话保留固定声明，即使命令目录为空。

## 持久化与恢复

正文作为已有 ToolOutcome／ToolResult 保存，不新增输入协议、SQLite 表或 JSONL variant。修改／删除文件不改写历史，重开不重新加载或自动执行。

加载意图已提交、结果未提交时，恢复补 Cancelled，允许后续普通 Run。意图本身尚未提交的未闭合调用继续沿用原保护，不从模型输出推断执行事实。相同 input ID 重试已接纳请求返回原 Run，不重扫或执行。系统更新或结果提交失败阻止相应后续生成。
