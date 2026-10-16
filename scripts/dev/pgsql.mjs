import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopProcessGroup } from "./dev-process.mjs";
import { ensureEnvironment } from "./server-config.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const compose = [
  "compose",
  "--env-file",
  "server/config/.env",
  "-p",
  "xiaowei-dev",
  "-f",
  "server/deploy/compose.yaml",
];

async function runCommand(command, args, { cwd, signal }) {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  let failure;
  child.on("error", (error) => {
    failure = error;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let cleanup;
  const abort = () => {
    cleanup = stopProcessGroup(child, closed);
    cleanup.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const code = await closed;
    await cleanup;
    signal?.throwIfAborted();
    if (failure) throw new Error(`无法运行 ${command}，请检查是否安装。`);
    if (code !== 0) throw new Error("PostgreSQL 操作失败，请检查 Docker 输出与配置。");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function start({
  root = workspace,
  run = runCommand,
  print = console.log,
  signal,
} = {}) {
  ensureEnvironment({ root, print });
  print("启动共享 PostgreSQL，等待就绪……");
  await run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "60", "db"], {
    cwd: root,
    signal,
  });
  print("共享 PostgreSQL 已就绪。");
}

export async function stop({
  root = workspace,
  run = runCommand,
  print = console.log,
  signal,
} = {}) {
  print("停止共享 PostgreSQL（影响所有工作区），保留容器与数据卷……");
  await run("docker", [...compose, "stop", "db"], { cwd: root, signal });
  print("共享 PostgreSQL 已停止，数据保留。");
}

export async function restart(options = {}) {
  ensureEnvironment(options);
  await stop(options);
  await start(options);
}

export async function status({ root = workspace, run = runCommand, signal } = {}) {
  await run("docker", [...compose, "ps", "--all", "db"], { cwd: root, signal });
}

if (import.meta.main) {
  const commands = { start, stop, restart, status };
  const name = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(commands, name ?? "")) {
    console.error("用法：just db <start|stop|restart|status>");
    process.exitCode = 1;
  } else {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      await commands[name]({ signal: cancellation.signal });
    } catch (error) {
      console.error(cancellation.signal.aborted ? "PostgreSQL 操作已取消。" : error.message);
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}
