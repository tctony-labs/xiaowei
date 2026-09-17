import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import log from "electron-log/node";

// Keep the original console method: reporting a file error must not write to the same file again.
const reportFileError = console.error.bind(console);

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dailyFiles(directory: string) {
  let lastCleanupDate = "";
  function resolvePath() {
    const now = new Date();
    const today = localDate(now);
    if (lastCleanupDate !== today) {
      lastCleanupDate = today;
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - 14);
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const match = /^(\d{4}-\d{2}-\d{2})-xiaowei(?:-\d{2}-\d{2}-\d{2}-\d{3}(?:-\d+)?)?\.log$/.exec(entry.name);
          if (entry.isFile() && match && match[1] < localDate(cutoff)) {
            try {
              unlinkSync(join(directory, entry.name));
            } catch (error) {
              reportFileError("Unable to remove expired log", entry.name, error);
            }
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          reportFileError("Unable to clean log directory", error);
        }
      }
    }
    return join(directory, `${today}-xiaowei.log`);
  }

  function archive(file: { toString(): string }) {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((value) => String(value).padStart(2, "0"))
      .concat(String(now.getMilliseconds()).padStart(3, "0"))
      .join("-");
    const path = file.toString();
    const prefix = `${path.slice(0, -4)}-${time}`;
    let destination = `${prefix}.log`;
    for (let suffix = 1; existsSync(destination); suffix++) {
      destination = `${prefix}-${suffix}.log`;
    }
    renameSync(path, destination);
  }

  resolvePath();
  return { resolvePath, archive };
}

export function createLoggers(directory: string, development: boolean) {
  const files = dailyFiles(directory);
  function create(name: string) {
    const logger = log.create({ logId: name });
    logger.hooks.push((message) => ({
      ...message,
      variables: {
        ...message.variables,
        processType: message.variables?.processType ?? "main",
        paddedLevel: message.level.padStart(5, " "),
      },
    }));
    const level = development ? "debug" : "info";
    logger.transports.file.resolvePathFn = files.resolvePath;
    logger.transports.file.archiveLogFn = files.archive;
    logger.transports.file.maxSize = 20 * 1024 * 1024;
    logger.transports.file.sync = true;
    logger.transports.file.level = level;
    logger.transports.console.level = level;
    if (logger.transports.ipc) logger.transports.ipc.level = false;
    logger.transports.remote.level = false;
    const format = `{y}-{m}-{d} {h}:{i}:{s}.{ms} [{paddedLevel}] [${name}] {text}`;
    logger.transports.file.format = format;
    logger.transports.console.format = `%c{y}-{m}-{d} {h}:{i}:{s}.{ms} [{paddedLevel}] [${name}]%c {text}`;
    return logger;
  }
  return { main: create("main"), renderer: create("renderer") };
}

export function attachRendererLogging(contents: WebContents, logger: ReturnType<typeof createLoggers>["renderer"]) {
  contents.on("console-message", (event) => {
    const level = event.level === "warning" ? "warn" : event.level;
    logger[level](`${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  contents.on("render-process-gone", (_event, details) => {
    logger.error("Renderer process exited", details);
  });
  contents.on("preload-error", (_event, path, error) => {
    logger.error("Preload failed", path, error);
  });
}
