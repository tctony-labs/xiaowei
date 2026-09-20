type LogMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

// Keep the first string argument as the format string (%s, %d, %c, etc.).
// The receiver recognizes this prefix and omits the generated script's location.
export function sourceLog(method: LogMethod, location: string, ...args: unknown[]): void {
  const prefix = `[${location}]`;
  if (typeof args[0] === "string") {
    console[method](`${prefix} ${args[0]}`, ...args.slice(1));
  } else {
    console[method](prefix, ...args);
  }
}

export function hasSourceLocation(message: string): boolean {
  return /^\[(?!\/|\.\.?\/|[A-Za-z]:)[^\]\r\n]+\.[cm]?[jt]sx?:\d+\](?: |$)/.test(message);
}
