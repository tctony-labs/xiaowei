import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachWorker } from "xiaowei-gateway/worker-host";

test("plain Node loads built worker exports without a TS loader", async () => {
  const host = new GatewayHost();
  const worker = new Worker(new URL("./fixtures/worker.mjs", import.meta.url), {
    execArgv: [],
    workerData: { built: true },
  });
  const handle = await attachWorker(host, "built", worker);
  try {
    const client = host.client({ caller: "built-test", trusted: true });
    const route = handle.manifest.routes.find((r) => r.kind === "unary");
    const streamRoute = handle.manifest.routes.find((r) => r.kind === "serverStreaming");
    const payload = Uint8Array.of(8, 255, 1);
    assert.deepEqual(await client.invoke(route, payload), payload);
    const stream = await client.stream(streamRoute, payload);
    assert.deepEqual((await stream.next()).value, payload);
    assert.equal((await stream.next()).done, true);
  } finally {
    await handle.close();
  }
});
