import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after } from "node:test";

let binary: string | undefined;
let directory: string | undefined;
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

export async function attachAuthWebsocket(server: Server, target: string) {
  if (!binary) {
    directory = mkdtempSync(join(tmpdir(), "xw-auth-ws-"));
    binary = join(directory, "fixture");
    execFileSync("go", ["build", "-race", "-o", binary, "./internal/httpapi/ws/testfixture"], {
      cwd: new URL("../../../server", import.meta.url),
      stdio: "inherit",
      timeout: 120_000,
    });
  }
  const fixture = spawn(binary, [], {
    env: { XIAOWEI_AUTH_FIXTURE_TARGET: target },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  fixture.stderr.on("data", (bytes) => {
    diagnostics += bytes;
  });
  const address = await new Promise<URL>((resolve, reject) => {
    const reader = createInterface({ input: fixture.stdout });
    const timer = setTimeout(() => reject(new Error("fixture startup timed out")), 5000);
    fixture.once("error", reject);
    reader.once("line", (line) => {
      clearTimeout(timer);
      reader.close();
      resolve(new URL(line));
    });
  });
  const sockets = new Set<Socket>();
  server.on("upgrade", (request, downstream, head) => {
    const upstream = connect(Number(address.port), address.hostname, () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n`);
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        upstream.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`);
      }
      upstream.write("\r\n");
      upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.on("close", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
  });
  const disconnect = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    disconnect,
    close: async () => {
      disconnect();
      const stopped = new Promise<void>((resolve) => fixture.once("exit", () => resolve()));
      fixture.stdin.end();
      await stopped;
      assert.equal(diagnostics.includes("DATA RACE"), false, diagnostics);
      assert.equal(fixture.exitCode, 0, diagnostics);
    },
  };
}
