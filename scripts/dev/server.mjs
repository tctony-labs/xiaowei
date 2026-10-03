import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { stopProcessGroup } from "./dev-process.mjs";

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
    if (code !== 0) throw new Error(`${command} ${args.at(0)} 失败，请检查配置与服务状态。`);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export async function prepareServer({
  root = workspace,
  run = runCommand,
  print = console.log,
  signal,
  recreate = false,
} = {}) {
  const templates = [
    ["server/config/server.example.yaml", "server/config/server.yaml"],
    ["server/config/.env.example", "server/config/.env"],
  ];
  const missing = templates.filter(([, path]) => !existsSync(join(root, path)));
  if (missing.length) {
    print("缺少本地服务端配置。\n");

    print("1. 在仓库根目录复制缺少的配置文件：\n");
    for (const [template, path] of missing) print(`cp ${template} ${path}`);

    print("\n2. 完成后重新运行：\n");
    print("just prepare-server\n");

    throw new Error("配置文件尚未准备好，未启动 Docker 依赖。");
  }

  print(recreate ? "重建 Docker 依赖容器（保留数据卷），等待就绪……" : "启动 Docker 依赖，等待就绪……");
  const args = [...compose, "up", "-d", "--wait", "--wait-timeout", "60"];
  if (recreate) args.push("--force-recreate");
  await run("docker", args, { cwd: root, signal });
  print("Docker 依赖已就绪。");
}

export function runServerDevelopment({
  input = process.stdin,
  signals = process,
  print = console.log,
  startServer = () =>
    spawn("go", ["run", "./cmd/xiaowei-server"], {
      cwd: join(workspace, "server"),
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    }),
  stopServer = stopProcessGroup,
  restartDependencies = (signal) => prepareServer({ recreate: true, signal, print }),
  stopDependencies = () => runCommand("docker", [...compose, "stop"], { cwd: workspace }),
} = {}) {
  let child;
  let closed;
  let queue = Promise.resolve();
  let stopping = false;
  let restarting = false;
  let stopped;
  const cancellation = new AbortController();
  const wasRaw = input.isRaw;

  function start() {
    print("启动 Go server……");
    signals.exitCode = 0;
    child = startServer();
    closed = new Promise((resolve) => child.once("close", resolve));
    child.on("error", (error) => {
      signals.exitCode = 1;
      print(`Go server 启动失败：${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (!stopping && !restarting && (code || signal)) {
        signals.exitCode = code || 1;
        print(`Go server 已退出（${code ?? signal}），按 r 重试。`);
      }
    });
  }

  async function restart(full) {
    restarting = true;
    try {
      await stopServer(child, closed);
      if (stopping) return;
      if (full) await restartDependencies(cancellation.signal);
      if (!stopping) start();
    } finally {
      restarting = false;
    }
  }

  const commands = [
    { key: "r", description: "重新编译并重启 Go server", run: () => restart(false) },
    { key: "R", description: "重启 Docker 依赖与 Go server（保留数据）", run: () => restart(true) },
    { key: "h", description: "显示命令列表", run: () => showHelp() },
  ];

  function showHelp() {
    const entries = commands.map(({ key, description }) => `  ${key}  ${description}`);
    print(
      ["\n服务端开发命令（直接按键，无需回车）：", ...entries, "  Ctrl+C  退出并停止 Docker 依赖，保留数据\n"].join(
        "\n",
      ),
    );
  }

  function announce(key, description) {
    const label = styleText(["bold", "magentaBright"], `[${key}] ${description}`);
    print(`\n${"─".repeat(56)}\n${label}\n${"─".repeat(56)}`);
  }

  function onKey(text, key) {
    if (key?.ctrl && key.name === "c") {
      if (!stopping) announce("Ctrl+C", "退出服务端开发实例");
      void stop();
      return;
    }
    if (stopping || key?.ctrl || key?.meta) return;
    const command = commands.find((command) => command.key === text);
    if (!command) return;
    if (command.key === "h") {
      announce(command.key, command.description);
      return showHelp();
    }
    queue = queue
      .then(async () => {
        if (stopping) return;
        announce(command.key, command.description);
        await command.run();
      })
      .catch((error) => {
        if (!stopping) print(`服务端开发命令失败：${error.message}`);
      });
  }

  function stop() {
    if (stopped) return stopped;
    stopping = true;
    cancellation.abort();
    input.off("keypress", onKey);
    if (input.isTTY) {
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    }
    stopped = queue
      .then(() => stopServer(child, closed))
      .then(async () => {
        print("停止 Docker 依赖，保留数据……");
        await stopDependencies();
        print("服务端开发实例已退出，Docker 依赖已停止，数据保留。");
      })
      .catch((error) => {
        print(`服务端退出失败：${error.message}`);
        signals.exitCode = 1;
      })
      .finally(() => {
        signals.off("SIGINT", onInterrupt);
        signals.off("SIGTERM", onTerminate);
      });
    return stopped;
  }

  function stopFromSignal(signal) {
    if (!stopping) announce(signal, "收到停止请求，正在退出服务端开发实例");
    void stop();
  }

  function onInterrupt() {
    stopFromSignal("SIGINT");
  }

  function onTerminate() {
    stopFromSignal("SIGTERM");
  }

  start();
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  if (input.isTTY) {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on("keypress", onKey);
    input.resume();
    showHelp();
  }
  return { stop, idle: () => queue };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--prepare") {
    const cancellation = new AbortController();
    const stop = () => cancellation.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await prepareServer({ signal: cancellation.signal });
    } catch (error) {
      console.error(cancellation.signal.aborted ? "服务端准备已取消。" : error.message);
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } else if (process.argv.length === 2) {
    runServerDevelopment();
  } else {
    console.error("用法：node scripts/dev/server.mjs [--prepare]");
    process.exitCode = 1;
  }
}
