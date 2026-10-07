---
name: maintain-agent-session
description: >-
  维护 XiaoWei Agent 会话数据。用户要求按 session ID 查看本机会话数据，
  或清空、清理本机开发会话历史时使用；提供只读查询和离线清理 workflow。
---

# 维护 Agent 会话

## Workflow Inpsect

根据 session ID 定位 SQLite 会话记录与 JSONL 历史，直接只读检查磁盘数据。不要通过 Agent 的打开会话／ReadSession 接口检查文件；打开会话可能修复尾部并追加恢复记录。

### 1. 确定根目录并查询会话

Agent 根目录使用绝对路径 `XIAOWEI_AGENT_HOME`，未设置时为 `~/.xiaowei`；若用户指定其他实例，先确认该实例实际使用的根目录。SQLite 位于 `<Agent 根目录>/sessions.sqlite`。

以只读模式打开已有数据库（例如 Python `sqlite3.connect` 使用文件 URI 的 `mode=ro` 和 `uri=True`），将 session ID 作为绑定参数查询，避免创建不存在的数据库：

```sql
SELECT * FROM session WHERE session_id = ?;
```

`session` 保存标题、自动标题开关、创建／更新时间、归档和删除状态。`meta` 保存根目录级 KV 配置，不是单个会话的历史。数据库不存在或没有对应行时，分别报告，不创建、导入或修复数据。

### 2. 定位并读取 JSONL

使用查询结果的 `created_at_ms` 转为 **UTC** 年月，文件路径为：

```text
<Agent 根目录>/sessions/YYYY/MM/<session_id>.jsonl
```

年月取 SQLite 的创建时间，不使用 UUID 中的时间或本地时区，也不通过扫描全部 JSONL 作为常规定位方式。对应工作目录为 `<Agent 根目录>/workspaces/<session_id>/`。

只读查看 JSONL，按行号定位记录。首条 SessionHeader 的外层保存 `schema_version`、`session_id` 和作为创建时间的 `timestamp_ms`；payload 仅为 `{"type":"session_header"}`。第二条 Meta 保存初始模型配置，后续 Meta 表示配置变化。后续记录省略版本和会话 ID；`sequence` 按行序重建。标题和归档状态只在 SQLite 中；JSONL 保存模型配置及运行历史，精简记录中的归属和上下文信息可能继承前面的记录，不能把单行视为完整的重放结果。

报告数据库路径、会话行、JSONL 路径及相关记录；文件缺失时单独报告，不自动清理或修复。检查可在应用运行时进行，无需停止所有工作区，但 SQLite 和 JSONL 可能在读取期间变化；需要一致结果时说明这一限制，再协调暂停相关写入。

## Workflow Clean

清理 `<Agent 根目录>/sessions.sqlite` 的 `session` 表，以及该根目录 `sessions/` 下所有 `.jsonl` 文件，包含归档、待删除会话和未登记的 JSONL。不删除数据库文件或改变表结构，不创建备份。

保留 SQLite `meta` 中的自动归档／删除设置、`models.json`、锁文件、工作目录及其他数据。JSONL 尾部诊断副本不属于 `.jsonl`，也保留；用户扩大清理范围时另行明确目标，不直接删除整个 Agent 根目录。

### 1. 检查进程并收集清单

在仓库根目录运行：

```bash
python3 .agent/skills/maintain-agent-session/scripts/clean.py
```

脚本使用绝对路径 `XIAOWEI_AGENT_HOME`，未设置时使用 `~/.xiaowei`；需要明确覆盖时传 `--root /absolute/path`。

- 检查全局 `~/.xiaowei/.dev.pid`。文件不存在或 PID 已退出，不能单独作为所有工作区已停止的证据。
- 补查进程命令和 cwd，覆盖所有 XiaoWei 工作区的开发控制器、nodemon、桌面 App 和 CLI；孤立监听器也会阻止清理。
- 检查 SQLite 是否被其他进程打开。发现运行实例或数据库连接时停止，不自行结束其他工作区进程，不删除 PID 文件；向用户报告 PID 和归属，待用户处理或明确授权停止。
- 脚本不启动应用，不清理 Go 服务端数据，不扫描其他位置的 JSONL。

检查通过后，脚本打印根目录、会话 ID／标题／归档状态、全部目标文件及确认摘要。预览不删除数据。

### 2. 向用户确认

把实际清单和数量展示给用户，明确此次不备份。**必须针对这次清单取得用户确认，不能用先前“可以删除数据”的概括授权代替。** 用户确认前，不传 `--confirm`。

提示用户在清理完成前不要启动任何 XiaoWei 工作区。保存本次预览的根目录和完整 `confirmation_digest`，不要在用户确认后自动换用新清单的摘要。

### 3. 执行并验收

用户明确确认后，用预览的根目录和摘要执行：

```bash
python3 .agent/skills/maintain-agent-session/scripts/clean.py \
  --root /absolute/agent/root \
  --confirm '<confirmation_digest>'
```

脚本再次检查进程、数据库连接和清单；摘要变化时拒绝清理，重新预览并重新确认。执行时取得已有会话写锁和 SQLite 写事务，删除目标 JSONL、清空 `session` 表，再验证会话行数及 JSONL 数量均为零。

文件与 SQLite 不构成跨资源原子事务。失败时报告已经删除的文件数量，不宣称全部成功；排除错误后重新预览剩余数据并取得确认。不自动重试、不做备份或恢复，不启动或重启应用。

脚本只用 Python 标准库及 Unix 的 `ps`、`lsof`，支持本项目的 macOS／Linux 开发环境。
