import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, methodRoute } from "../src/binding/index.js";
import { createClient } from "../src/core/client.js";
import { GatewayFailure, type Result } from "../src/core/protocol.js";
import { createContext, GatewayHost } from "../src/core/registry.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("shared PB contract executes TS → Rust and Rust → TS through generic adapters", async () => {
  const build = spawnSync("cargo", ["build", "-q", "-p", "xw-gateway", "--example", "fixture_transport"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  const binary = `${root}/target/debug/examples/fixture_transport`;
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const transport = createClient({
    async invoke(route, payload) {
      child.stdin.write(`${JSON.stringify({ route, payload: [...payload] })}\n`);
      const frame = JSON.parse((await lines.next()).value ?? "") as Result<number[]>;
      return frame.ok ? { ok: true, value: Uint8Array.from(frame.value) } : frame;
    },
    subscribe() {
      throw new Error("fixture only tests unary");
    },
  });
  try {
    const echo = bindClient(Fixture, transport);
    for (const value of [
      undefined,
      { case: "stringValue", value: "hello" },
      { case: "nullValue", value: 0 },
    ] as const) {
      const payload = create(EnvelopeSchema, {
        text: "TS → Rust 中文",
        id: 0xffffffffffffffffn,
        label: "",
        value,
        blobs: [{ data: new Uint8Array(2 * 1024 * 1024).fill(255) }],
      });
      assert.deepEqual(await echo.echo(payload), payload);
    }
    await assert.rejects(
      transport.invoke(methodRoute(Fixture.method.echo), new Uint8Array([255])),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      echo.echo(create(EnvelopeSchema, { text: "fail" })),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "HANDLER_ERROR",
    );
    await assert.rejects(
      transport.invoke({ ...methodRoute(Fixture.method.echo), name: "missing.route" }, new Uint8Array()),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "UNKNOWN_ROUTE",
    );
    await assert.rejects(
      transport.invoke(methodRoute(Fixture.method.watch), new Uint8Array()),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "WRONG_METHOD_KIND",
    );
  } finally {
    child.stdin.end();
  }
  assert.equal((await once(child, "exit"))[0], 0);
  const rustClient = spawn(binary, ["--client"], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(rustClient, "exit");
  const host = new GatewayHost();
  host.registerOwner("ts", bindHandlers(Fixture, { echo: (p) => p }));
  for await (const line of createInterface({ input: rustClient.stdout })) {
    const frame = JSON.parse(line);
    const result = await host.invoke(
      createContext({ caller: "rust", trusted: true }),
      frame.route,
      Uint8Array.from(frame.payload),
    );
    rustClient.stdin.end(`${JSON.stringify(result.ok ? { ok: true, value: [...result.value] } : result)}\n`);
  }
  assert.equal((await exited)[0], 0);
});
