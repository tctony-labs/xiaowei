import { spawn } from "node:child_process";
import { closeSync, openSync, utimesSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

function touchRestart() {
  closeSync(openSync(new URL("../../desktop/.rs", import.meta.url), "a"));
  const now = new Date();
  utimesSync(new URL("../../desktop/.rs", import.meta.url), now, now);
}

export function runDevelopment({
  input = process.stdin,
  signals = process,
  print = console.log,
  startSession = () =>
    spawn(process.execPath, [fileURLToPath(new URL("./dev-session.mjs", import.meta.url))], {
      cwd: fileURLToPath(new URL("../../desktop", import.meta.url)),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  restartElectron = touchRestart,
} = {}) {
  let session;
  let closed;
  let queue = Promise.resolve();
  let stopping = false;
  let stopped;
  const wasRaw = input.isRaw;

  function start() {
    session = startSession();
    closed = new Promise((resolve) => session.once("close", resolve));
    session.on("error", (error) => print(`开发进程启动失败：${error.message}`));
    session.on("exit", (code) => {
      if (!stopping && code) print(`开发进程已退出（${code}），按 R 重试。`);
    });
  }

  async function stopSession() {
    const running = session.exitCode === null && session.signalCode === null;
    if (running) {
      if (session.connected) session.send({ type: "stop" });
      else session.kill("SIGTERM");
    }
    await closed;
    if (!stopping && running && session.exitCode !== 0) throw new Error("旧开发进程未正常退出，取消启动新实例");
  }

  const commands = [
    {
      key: "R",
      description: "重启 Vite + Electron",
      run: async () => {
        await stopSession();
        if (!stopping) start();
      },
    },
    { key: "r", description: "重建 main/preload 并重启 Electron", run: restartElectron },
    { key: "h", description: "显示命令列表", run: () => showHelp() },
  ];
  function showHelp() {
    const entries = commands.map(({ key, description }) => `  ${key}  ${description}`);
    print(["\n开发命令（直接按键，无需回车）：", ...entries, "  Ctrl+C  退出\n"].join("\n"));
  }
  function announce(key, description) {
    const label = styleText(["bold", "magentaBright"], `[${key}] ${description}`);
    print(`\n${"─".repeat(56)}\n${label}\n${"─".repeat(56)}`);
  }
  function onKey(text, key) {
    if (key?.ctrl && key.name === "c") {
      if (!stopping) announce("Ctrl+C", "退出开发实例");
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
      .then(() => {
        if (!stopping) {
          announce(command.key, command.description);
          return command.run();
        }
      })
      .catch((error) => print(`开发命令失败：${error.message}`));
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
      .then(stopSession)
      .then(() => print("开发实例已退出。"))
      .catch((error) => {
        print(`开发进程退出失败：${error.message}`);
        signals.exitCode = 1;
      })
      .finally(() => {
        signals.off("SIGINT", onInterrupt);
        signals.off("SIGTERM", onTerminate);
      });
    return stopped;
  }

  function stopFromSignal(signal) {
    if (!stopping) announce(signal, "收到外部停止请求，正在退出开发实例");
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

if (process.argv[1] === fileURLToPath(import.meta.url)) runDevelopment();
