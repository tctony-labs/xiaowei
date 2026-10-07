#!/usr/bin/env python3
"""Preview Agent history cleanup; execute only with the approved preview digest."""

import argparse
from contextlib import ExitStack, closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys


class CleanupError(Exception):
    pass


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=10)
    if result.returncode not in (0, 1) or (result.returncode == 1 and result.stderr.strip()):
        raise CleanupError(f"无法完成检查：{arguments[0]}: {result.stderr.strip()}")
    return result.stdout


def processes():
    result = {}
    for line in command(["ps", "-axo", "pid=,ppid=,command="]).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            result[int(parts[0])] = {"ppid": int(parts[1]), "command": parts[2]}
    return result


def working_directories(pids):
    if not pids:
        return {}
    if sys.platform.startswith("linux"):
        return {pid: str(Path(f"/proc/{pid}/cwd").resolve()) for pid in pids}

    output = command(["lsof", "-a", "-p", ",".join(map(str, pids)), "-d", "cwd", "-Fn"])
    result = {}
    pid = None
    for line in output.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            result[pid] = line[1:]
    return result


def workspace(cwd):
    if not cwd:
        return None
    directory = Path(cwd)
    for parent in (directory, *directory.parents):
        manifest = parent / "package.json"
        if not manifest.is_file():
            continue
        try:
            name = json.loads(manifest.read_text()).get("name")
        except (OSError, ValueError):
            continue
        if name in ("xiaowei-workspace", "@xiaowei/desktop"):
            return str(parent)
    if any(part in ("xiaowei", "xiaowei-next") for part in directory.parts):
        return cwd
    return None


def ensure_stopped(root):
    snapshot = processes()
    pidfile = Path.home() / ".xiaowei" / ".dev.pid"
    blockers = {}
    if pidfile.exists():
        text = pidfile.read_text().strip()
        if not text.isdecimal() or int(text) <= 1:
            raise CleanupError(f"PID 文件格式异常，请先核对：{pidfile}")
        pid = int(text)
        if pid in snapshot:
            blockers[pid] = f"全局开发 PID：{snapshot[pid]['command']}"

    runtime = re.compile(
        r"nodemon|electron|scripts/dev/(?:dev|dev-session|build-desktop-main)\.mjs"
        r"|(?:^|\s)(?:pnpm|npm|bun)(?:\s+run)?\s+dev\b",
        re.IGNORECASE,
    )
    # Do not mistake the current tool shell (whose arguments contain source text) for an app.
    ancestors = {os.getpid()}
    parent = os.getppid()
    while parent in snapshot and parent not in ancestors:
        ancestors.add(parent)
        parent = snapshot[parent]["ppid"]
    candidates = []
    for pid, process in snapshot.items():
        if pid in ancestors:
            continue
        executable = Path(process["command"].split()[0]).name.lower()
        is_cli = executable in ("xiaowei", "xiaowei-cli")
        is_runtime = executable in ("node", "nodemon", "pnpm", "npm", "bun", "electron")
        if is_cli or (is_runtime and runtime.search(process["command"])):
            candidates.append(pid)
    directories = working_directories(candidates)
    for pid in candidates:
        process = snapshot[pid]
        owner = workspace(directories.get(pid))
        named_path = re.search(r"/xiaowei(?:-next)?/", process["command"])
        if owner or named_path:
            blockers[pid] = f"cwd={directories.get(pid, '未知')} {process['command']}"
    if blockers:
        details = "\n".join(f"  PID {pid}: {description}" for pid, description in sorted(blockers.items()))
        raise CleanupError(f"仍有 XiaoWei 开发／Agent 进程，未清理：\n{details}")

    opened = [root / name for name in ("sessions.sqlite", "sessions.sqlite-wal", "sessions.sqlite-shm")]
    opened = [str(path) for path in opened if path.exists()]
    if opened:
        holders = command(["lsof", "-nP", "-Fpc", "--", *opened]).strip()
        if holders:
            raise CleanupError(f"SQLite 仍被进程打开，请先释放连接：\n{holders}")


def jsonl_files(root):
    directory = root / "sessions"
    if not directory.exists() and not directory.is_symlink():
        return []
    if directory.is_symlink() or not directory.is_dir():
        raise CleanupError(f"会话目录不是普通目录：{directory}")
    result = []
    for parent, directories, files in os.walk(directory):
        for name in directories:
            if (Path(parent) / name).is_symlink():
                raise CleanupError(f"拒绝跟随会话目录符号链接：{Path(parent) / name}")
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = Path(parent) / name
            if path.is_symlink() or not path.is_file():
                raise CleanupError(f"目标不是普通文件：{path}")
            with path.open("rb") as file:
                checksum = hashlib.file_digest(file, "sha256").hexdigest()
            result.append({
                "path": str(path.relative_to(root)),
                "bytes": path.stat().st_size,
                "sha256": checksum,
            })
    return sorted(result, key=lambda file: file["path"])


def database_state(connection):
    connection.row_factory = sqlite3.Row
    schema = [tuple(row) for row in connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name"
    )]
    if "session" not in {row[0] for row in schema}:
        raise CleanupError("数据库缺少 session 表；不猜测旧结构，也不删除数据库文件")
    rows = [dict(row) for row in connection.execute("SELECT * FROM session ORDER BY session_id")]
    meta = []
    if "meta" in {row[0] for row in schema}:
        meta = [dict(row) for row in connection.execute("SELECT * FROM meta ORDER BY key")]
    return {"schema": schema, "sessions": rows, "meta": meta}


def inventory(root, connection=None):
    database = root / "sessions.sqlite"
    if database.is_symlink():
        raise CleanupError(f"拒绝操作数据库符号链接：{database}")
    state = None
    if connection is not None:
        state = database_state(connection)
    elif database.exists():
        with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as reader:
            state = database_state(reader)
    return {"root": str(root), "database": state, "files": jsonl_files(root)}


def digest(plan):
    encoded = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def show(plan):
    database = plan["database"]
    sessions = database["sessions"] if database else []
    print(f"Agent 根目录：{plan['root']}")
    print(f"待清理：{len(sessions)} 条 SQLite 会话，{len(plan['files'])} 个 JSONL 文件")
    for session in sessions:
        title = json.dumps(session.get("title", ""), ensure_ascii=False)
        print(f"  会话 {session['session_id']} 标题={title} archived={session.get('archived', False)}")
    ids = {session["session_id"] for session in sessions}
    for file in plan["files"]:
        orphan = "（未登记）" if Path(file["path"]).stem not in ids else ""
        print(f"  文件 {file['path']} ({file['bytes']} bytes){orphan}")
    print("保留数据库结构、meta 设置、模型配置、锁文件、工作目录和尾部诊断；不备份。")
    print(f"confirmation_digest: {digest(plan)}", flush=True)


def execute(root, plan):
    removed = 0
    with ExitStack() as stack:
        locks = root / "locks"
        if locks.is_symlink():
            raise CleanupError(f"拒绝操作锁目录符号链接：{locks}")
        for path in sorted(locks.glob("*.lock")):
            if path.is_symlink():
                raise CleanupError(f"拒绝操作锁文件符号链接：{path}")
            file = stack.enter_context(path.open("r+"))
            try:
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise CleanupError(f"会话写锁仍被占用：{path}") from error

        connection = None
        if plan["database"] is not None:
            connection = stack.enter_context(closing(sqlite3.connect(
                f"{(root / 'sessions.sqlite').as_uri()}?mode=rw", uri=True, timeout=0
            )))
            connection.execute("BEGIN EXCLUSIVE")
        try:
            if digest(inventory(root, connection)) != digest(plan):
                raise CleanupError("清单发生变化；请重新预览并取得用户确认")
            for file in plan["files"]:
                (root / file["path"]).unlink()
                removed += 1
            if connection is not None:
                connection.execute("DELETE FROM session")
                connection.commit()
        except (CleanupError, OSError, sqlite3.Error) as error:
            if connection is not None:
                connection.rollback()
            raise CleanupError(f"清理未完成，已删除 {removed} 个 JSONL；重新预览剩余数据。原因：{error}") from error

    remaining = inventory(root)
    rows = remaining["database"]["sessions"] if remaining["database"] else []
    if rows or remaining["files"]:
        raise CleanupError("清理后仍有会话或 JSONL，可能有新写入；不要自动扩大删除范围")
    if remaining["database"] != (dict(plan["database"], sessions=[]) if plan["database"] else None):
        raise CleanupError("清理后数据库结构或 meta 设置发生变化，请核对")
    print(f"清理完成：删除 {removed} 个 JSONL，SQLite 会话数为 0，保留设置已核对。")


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.environ.get("XIAOWEI_AGENT_HOME", str(Path.home() / ".xiaowei")))
    parser.add_argument("--confirm", help="用户已经确认的预览 confirmation_digest；不传则仅预览")
    options = parser.parse_args(arguments)
    root = Path(options.root).expanduser()
    if not root.is_absolute() or root.is_symlink():
        raise CleanupError("Agent 根目录必须是绝对路径且不是符号链接")
    root = root.resolve()
    ensure_stopped(root)
    plan = inventory(root)
    show(plan)
    if options.confirm is None:
        print("仅预览，未清理。展示清单并取得用户确认后，才使用 --confirm 执行。")
        return
    if options.confirm != digest(plan):
        raise CleanupError("确认摘要不匹配，未清理；请重新预览并取得用户确认")
    ensure_stopped(root)
    execute(root, plan)


if __name__ == "__main__":
    try:
        main()
    except (CleanupError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(f"错误：{error}", file=sys.stderr)
        sys.exit(1)
