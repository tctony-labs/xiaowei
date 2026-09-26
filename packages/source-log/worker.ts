import { Console } from "node:console";
import { createInterface } from "node:readline";
import { formatWithOptions } from "node:util";
import { isMainThread, Worker, type WorkerOptions } from "node:worker_threads";

const prefix = "\u001exiaowei-log:";
const levels = ["info", "warn", "error", "debug"] as const;
type Level = (typeof levels)[number];
type LogSink = Pick<Console, Level>;

// Node's worker stdout/stderr carry logs independently of the business MessagePort.
// JSON keeps multiline messages together and preserves the original console level.
export function initializeWorkerLogging(): void {
  if (isMainThread) throw new Error("Worker logging must be initialized inside a worker");
  const output = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: true });
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    console[method] = (...args: unknown[]) => {
      const level = method === "log" ? "info" : method === "trace" ? "debug" : method;
      let message = formatWithOptions({ colors: false }, ...args);
      if (method === "trace") {
        const trace = new Error(message);
        trace.name = "Trace";
        Error.captureStackTrace(trace, console[method]);
        message = trace.stack ?? message;
      }
      output.log(`${prefix}${JSON.stringify({ level, message })}`);
    };
  }
}

export function createLoggedWorker(
  name: string,
  filename: string | URL,
  options: WorkerOptions = {},
  sink: LogSink = console,
): Worker {
  const worker = new Worker(filename, { ...options, stdout: true, stderr: true });
  for (const [stream, fallback] of [
    [worker.stdout, "info"],
    [worker.stderr, "error"],
  ] as const) {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      let level: Level = fallback;
      let message = line;
      if (line.startsWith(prefix)) {
        try {
          const record = JSON.parse(line.slice(prefix.length));
          if (record && levels.includes(record.level) && typeof record.message === "string") {
            level = record.level;
            message = record.message;
          }
        } catch {
          // Direct writes from dependencies are still ordinary stdout/stderr.
        }
      }
      sink[level](`[worker.${name}] ${message}`);
    });
  }
  return worker;
}
