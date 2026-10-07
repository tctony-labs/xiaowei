"""Cleanup acceptance tests use temporary data and never launch XiaoWei."""

from contextlib import closing, redirect_stdout
import fcntl
import importlib.util
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("clean", Path(__file__).with_name("clean.py"))
clean = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clean)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        with closing(sqlite3.connect(self.root / "sessions.sqlite")) as connection:
            connection.executescript("""
                CREATE TABLE session (session_id TEXT PRIMARY KEY, title TEXT, archived INTEGER);
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO session VALUES ('active', '普通会话', 0), ('archived', '归档会话', 1);
                INSERT INTO meta VALUES ('retention.archive_after_days', '15');
            """)
        self.sessions = self.root / "sessions" / "2026" / "10"
        self.sessions.mkdir(parents=True)
        for name in ("active", "archived", "orphan"):
            (self.sessions / f"{name}.jsonl").write_text('{"example":1}\n')
        (self.sessions / "active.jsonl.tail-example").write_text("diagnostic")
        (self.root / "models.json").write_text("model settings")
        (self.root / "workspaces").mkdir()
        (self.root / "workspaces" / "keep.txt").write_text("workspace")
        (self.root / "locks").mkdir()
        (self.root / "locks" / "active.lock").touch()

    def run_main(self, *arguments):
        with patch.object(clean, "ensure_stopped"), redirect_stdout(io.StringIO()):
            clean.main(["--root", str(self.root), *arguments])

    def test_preview_never_deletes_and_confirmed_cleanup_preserves_other_data(self):
        before = clean.inventory(self.root)
        self.run_main()
        self.assertEqual(clean.inventory(self.root), before)

        self.run_main("--confirm", clean.digest(before))
        after = clean.inventory(self.root)
        self.assertEqual(after["files"], [])
        self.assertEqual(after["database"]["sessions"], [])
        self.assertEqual(after["database"]["meta"], before["database"]["meta"])
        self.assertEqual(after["database"]["schema"], before["database"]["schema"])
        self.assertEqual((self.root / "models.json").read_text(), "model settings")
        self.assertEqual((self.root / "workspaces" / "keep.txt").read_text(), "workspace")
        self.assertTrue((self.sessions / "active.jsonl.tail-example").is_file())
        self.assertTrue((self.root / "locks" / "active.lock").is_file())

    def test_changed_file_or_database_invalidates_confirmation(self):
        approved = clean.digest(clean.inventory(self.root))
        (self.sessions / "active.jsonl").write_text('{"changed":2}\n')
        before = clean.inventory(self.root)
        with self.assertRaisesRegex(clean.CleanupError, "摘要不匹配"):
            self.run_main("--confirm", approved)
        self.assertEqual(clean.inventory(self.root), before)

        approved = clean.digest(before)
        with closing(sqlite3.connect(self.root / "sessions.sqlite")) as connection:
            connection.execute("UPDATE session SET title = '新标题' WHERE session_id = 'active'")
            connection.commit()
        before = clean.inventory(self.root)
        with self.assertRaisesRegex(clean.CleanupError, "摘要不匹配"):
            self.run_main("--confirm", approved)
        self.assertEqual(clean.inventory(self.root), before)

    def test_held_writer_lock_prevents_cleanup(self):
        before = clean.inventory(self.root)
        with (self.root / "locks" / "active.lock").open("r+") as file:
            fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(clean.CleanupError, "写锁仍被占用"):
                self.run_main("--confirm", clean.digest(before))
        self.assertEqual(clean.inventory(self.root), before)

    def test_open_database_connection_prevents_cleanup(self):
        fake_home = self.root / "home"
        fake_home.mkdir()
        with closing(sqlite3.connect(self.root / "sessions.sqlite")) as connection:
            connection.execute("SELECT * FROM session").fetchall()
            with patch.object(clean.Path, "home", return_value=fake_home), \
                    patch.object(clean, "processes", return_value={}):
                with self.assertRaisesRegex(clean.CleanupError, "SQLite 仍被进程打开"):
                    clean.ensure_stopped(self.root)

    def test_file_deletion_failure_reports_partial_work_and_rolls_back_database(self):
        before = clean.inventory(self.root)
        original_unlink = clean.Path.unlink
        attempts = []

        def fail_second(path):
            attempts.append(path)
            if len(attempts) == 2:
                raise PermissionError("test failure")
            original_unlink(path)

        with patch.object(clean.Path, "unlink", fail_second):
            with self.assertRaisesRegex(clean.CleanupError, "已删除 1 个 JSONL"):
                self.run_main("--confirm", clean.digest(before))
        after = clean.inventory(self.root)
        self.assertEqual(len(after["files"]), 2)
        self.assertEqual(after["database"], before["database"])

    def test_symlinked_jsonl_does_not_delete_external_data(self):
        target = self.root / "external.txt"
        target.write_text("outside sessions")
        (self.sessions / "unsafe.jsonl").symlink_to(target)
        with self.assertRaisesRegex(clean.CleanupError, "不是普通文件"):
            self.run_main()
        self.assertEqual(target.read_text(), "outside sessions")

    def test_unregistered_orphan_watcher_blocks_even_without_pid_file(self):
        fake_home = self.root / "home"
        fake_home.mkdir()
        watcher = {
            4608: {"ppid": 1, "command": "node /checkout/node_modules/nodemon/bin/nodemon.js"},
        }
        with patch.object(clean.Path, "home", return_value=fake_home), \
                patch.object(clean, "processes", return_value=watcher), \
                patch.object(clean, "working_directories", return_value={4608: "/checkout/desktop"}), \
                patch.object(clean, "workspace", return_value="/checkout"):
            with self.assertRaisesRegex(clean.CleanupError, "PID 4608"):
                clean.ensure_stopped(self.root)

    def test_live_registered_pid_blocks_and_exited_pid_does_not(self):
        fake_home = self.root / "home"
        (fake_home / ".xiaowei").mkdir(parents=True)
        (fake_home / ".xiaowei" / ".dev.pid").write_text("9999")
        with patch.object(clean.Path, "home", return_value=fake_home), \
                patch.object(clean, "processes", return_value={9999: {"ppid": 1, "command": "node dev"}}):
            with self.assertRaisesRegex(clean.CleanupError, "PID 9999"):
                clean.ensure_stopped(self.root)
        with patch.object(clean.Path, "home", return_value=fake_home), \
                patch.object(clean, "processes", return_value={}), \
                patch.object(clean, "command", return_value=""):
            clean.ensure_stopped(self.root)

    def test_editor_monitor_is_not_mistaken_for_xiaowei_runtime(self):
        fake_home = self.root / "home"
        fake_home.mkdir()
        monitor = {9999: {"ppid": 1, "command": "cmux hooks codex monitor --cwd /checkout/xiaowei"}}
        with patch.object(clean.Path, "home", return_value=fake_home), \
                patch.object(clean, "processes", return_value=monitor), \
                patch.object(clean, "command", return_value=""):
            clean.ensure_stopped(self.root)

    def test_second_process_check_can_stop_execution(self):
        before = clean.inventory(self.root)
        checks = [None, clean.CleanupError("new watcher")]
        with patch.object(clean, "ensure_stopped", side_effect=checks), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(clean.CleanupError, "new watcher"):
                clean.main(["--root", str(self.root), "--confirm", clean.digest(before)])
        self.assertEqual(clean.inventory(self.root), before)


if __name__ == "__main__":
    unittest.main()
