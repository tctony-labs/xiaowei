import { execFileSync, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, styleText } from "node:util";
import { load } from "js-yaml";
import { stopProcessGroup } from "./dev-process.mjs";
import { start as startPostgres } from "./pgsql.mjs";
import { ensureServerConfiguration } from "./server-config.mjs";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
export async function checkServerPort({
  root = workspace,
  env = process.env,
  print = console.log,
  confirm = confirmPortTermination,
} = {}) {
  let address;
  try {
    const configuration = load(readFileSync(join(root, "server/config/server.yaml"), "utf8"));
    const envPath = join(root, "server/config/.env");
    const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
    address =
      env.XIAOWEI_LISTEN_ADDR ??
      fileEnv.XIAOWEI_LISTEN_ADDR ??
      configuration?.server?.listen_addr ??
      "127.0.0.1:10001";
  } catch {
    throw new Error("无法读取服务端监听配置，请检查 server/config/server.yaml 和 .env。");
  }

  const match = typeof address === "string" && /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(address);
  const port = match && Number(match[3]);
  if (!match || port < 1 || port > 65535) {
    throw new Error("server.listen_addr / XIAOWEI_LISTEN_ADDR 必须为有效的 host:port 地址。");
  }

  const host = match[1] ?? (match[2] || undefined);
  let bindHost;
  async function probe() {
    return new Promise((resolve, reject) => {
      const listener = createServer();
      listener.once("error", reject);
      listener.listen({ host: bindHost, port, exclusive: true }, () => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }

  try {
    bindHost = host ? (await lookup(host)).address : undefined;
    await probe();
    return;
  } catch (error) {
    print(`监听地址 ${address} 不可用（${error.code}），Go server 未启动。`);
    if (error.code !== "EADDRINUSE") throw new Error("监听地址预检失败，已取消启动。");
  }

  const users = reportPortUsers(port, bindHost, print);
  if (!users.length) throw new Error("无法确认占用进程，已取消启动。");
  const pids = users.map((user) => user.pid).join(", ");
  const accepted = await confirm(
    `是否终止以上监听进程（PID: ${pids}）并继续启动？[yes/no，默认 no] `,
  );
  if (!accepted) throw new Error("未确认终止进程，已取消启动。");

  for (const user of users) {
    let current;
    try {
      current = processIdentity(user.pid);
    } catch (error) {
      if (error.status === 1) continue;
      throw new Error(`无法重新核对 PID=${user.pid}，已取消启动。`);
    }
    if (current !== user.identity) {
      throw new Error(`PID=${user.pid} 的进程信息已变化，请重新启动并核对。`);
    }
    try {
      execFileSync("kill", ["-TERM", user.pid], { timeout: 1000, stdio: "pipe" });
    } catch {
      throw new Error(`终止 PID=${user.pid} 失败，请检查权限与进程状态。`);
    }
    print(`已向监听进程 PID=${user.pid} 发送 SIGTERM，等待端口释放……`);
  }

  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await probe();
      print(`监听地址 ${address} 已释放，继续启动。`);
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || Date.now() >= deadline) {
        throw new Error(`监听地址 ${address} 仍不可用（${error.code}），未启动 Go server。`);
      }
      await delay(100);
    }
  }
}

async function confirmPortTermination(question) {
  if (!process.stdin.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => {
      terminal.once("close", () => resolve(""));
      terminal.question(question, resolve);
    });
    return /^(yes|y)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

function processIdentity(pid) {
  return execFileSync("ps", ["-p", pid, "-o", "pid=,ppid=,lstart=,comm="], {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function reportPortUsers(port, host, print) {
  const deadline = Date.now() + 5000;
  function query(command, args) {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: Math.max(1, deadline - Date.now()),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function reportProcess(pid, label) {
    try {
      const fields = query("ps", ["-p", pid, "-o", "pid=,ppid=,pgid=,comm="]).split(/\s+/);
      print(
        `${label} PID=${fields[0]} PPID=${fields[1]} PGID=${fields[2]} 程序=${fields.slice(3).join(" ")}`,
      );
      const cwd = query("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])
        .split("\n")
        .find((line) => line.startsWith("n"));
      print(`  cwd=${cwd?.slice(1) ?? "未知"}`);
      return fields[1];
    } catch {
      print(`${label} PID=${pid}（部分进程信息无法读取，进程可能已退出或权限不足）`);
    }
  }

  try {
    const records = query("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"]);
    const listeners = [];
    let listener;
    for (const record of records.split("\n")) {
      if (record.startsWith("p")) {
        listener = { pid: record.slice(1), addresses: [] };
        listeners.push(listener);
      } else if (record.startsWith("n")) {
        listener?.addresses.push(record.slice(1));
      }
    }
    const users = listeners.filter((user) =>
      user.addresses.some((address) => {
        const local = address.slice(0, address.lastIndexOf(":")).replace(/^\[|\]$/g, "");
        return !host || host === "0.0.0.0" || host === "::" || local === "*" || local === host;
      }),
    );
    print("占用进程（请结合地址和 cwd 核对归属）：");
    for (const user of users) {
      user.identity = processIdentity(user.pid);
      const parent = reportProcess(user.pid, "监听进程");
      if (parent && parent !== "1") reportProcess(parent, "父进程");
      for (const address of user.addresses) print(`  监听地址：${address}`);
    }
    return users;
  } catch {
    print("无法取得监听进程信息（lsof 不可用、权限不足或占用已变化），请手动检查。");
    return [];
  }
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
} = {}) {
  let child;
  let closed;
  let queue = Promise.resolve();
  let stopping = false;
  let restarting = false;
  let stopped;
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

  async function restart() {
    restarting = true;
    try {
      await stopServer(child, closed);
      if (!stopping) start();
    } finally {
      restarting = false;
    }
  }

  const commands = [
    { key: "r", description: "重新编译并重启 Go server", run: restart },
    { key: "h", description: "显示命令列表", run: () => showHelp() },
  ];

  function showHelp() {
    const entries = commands.map(({ key, description }) => `  ${key}  ${description}`);
    print(
      [
        "\n服务端开发命令（直接按键，无需回车）：",
        ...entries,
        "  Ctrl+C  退出 Go server，保留共享 PostgreSQL\n",
      ].join("\n"),
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
    input.off("keypress", onKey);
    if (input.isTTY) {
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    }
    stopped = queue
      .then(() => stopServer(child, closed))
      .then(() => print("服务端开发实例已退出；共享 PostgreSQL 请用 just db 管理。"))
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
  if (process.argv.length !== 2) {
    console.error("用法：node scripts/dev/server.mjs");
    process.exitCode = 1;
  } else {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    let ready = false;
    try {
      ensureServerConfiguration();
      await checkServerPort();
      await startPostgres({ signal: cancellation.signal });
      ready = true;
    } catch (error) {
      console.error(cancellation.signal.aborted ? "服务端准备已取消。" : error.message);
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    if (ready) runServerDevelopment();
  }
}
