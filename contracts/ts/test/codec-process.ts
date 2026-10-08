import { spawnSync } from "node:child_process";
import { basename } from "node:path";

interface CodecOptions {
  caseName: string;
  args?: string[];
  expectFailure?: boolean;
  timeoutMs?: number;
}

export function runCodec(bin: string, input: Uint8Array, options: CodecOptions): Uint8Array<ArrayBuffer> {
  const { caseName, args = [], expectFailure = false, timeoutMs = 10_000 } = options;
  const context = `${caseName}: ${basename(bin)} (${args[0] ?? "envelope"}, ${input.byteLength} input bytes)`;
  console.log(`[codec] Starting ${context}`);
  const started = performance.now();
  const result = spawnSync(bin, args, {
    input,
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    // SIGTERM can be ignored; these standalone codec programs have no descendants to clean up.
    killSignal: "SIGKILL",
  });

  // Infrastructure failures must never count as successful rejection of invalid wire data.
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason = code === "ETIMEDOUT" ? `timed out after ${timeoutMs}ms` : result.error.message;
    throw new Error(`${context}: ${reason}`, { cause: result.error });
  }
  if (result.signal || result.status === null) {
    throw new Error(`${context}: terminated without an exit code (signal ${result.signal})`);
  }
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`${context}: unexpected exit code ${result.status}${stderr ? `; ${stderr}` : ""}`);
  }

  console.log(`[codec] Finished ${context}: exit ${result.status}, ${Math.round(performance.now() - started)}ms`);
  return new Uint8Array(result.stdout);
}
