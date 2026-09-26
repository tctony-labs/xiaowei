import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, PeerFixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, bindStreamClient, bindStreamHandlers, methodRoute } from "../src/binding/index.js";
import { GatewayFailure } from "../src/core/protocol.js";
import { GatewayHost } from "../src/core/registry.js";
import { attachWorker } from "../src/main/worker.js";
import { Connection } from "../src/worker/protocol.js";
import { workerFixture } from "./fixtures/worker-client.js";

const code = (code: string) => (e: unknown) => e instanceof GatewayFailure && e.detail.code === code;
const request = (text = "", id = 3n) =>
  create(EnvelopeSchema, { text, id, blobs: [{ data: Uint8Array.of(0, 128, 255) }] });
const clients = (host: GatewayHost) => {
  const client = host.client({ caller: "main", trusted: true });
  return { unary: bindClient(Fixture, client), stream: bindStreamClient(Fixture, client) };
};

async function afterAdmissionReleased<T>(call: () => Promise<T>, fullCode: string): Promise<T> {
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      return await call();
    } catch (error) {
      if (!code(fullCode)(error) || performance.now() >= deadline) throw error;
      await setImmediate();
    }
  }
}

test("worker typed unary and interleaved streams execute off main and preserve PB", async () => {
  const fixture = await workerFixture();
  try {
    const { unary, stream } = clients(fixture.host);
    assert.equal((await unary.echo(request("thread"))).id, BigInt(fixture.worker.threadId));
    assert.deepEqual(await unary.echo(request()), request());
    const a = await stream.watch(request());
    const b = await stream.watch(request());
    for (let i = 0n; i < 3n; i++) {
      for (const source of [a, b]) {
        const chunk = await source.next();
        assert.equal(chunk.value?.value?.id, i);
        assert.deepEqual(chunk.value?.value?.blobs[0]?.data, request().blobs[0]?.data);
      }
    }
    assert.equal((await a.next()).done, true);
    assert.equal((await b.next()).done, true);
    await Promise.all([a.closed, b.closed]);
    const failed = await stream.watch(request("fail"));
    await failed.next();
    await assert.rejects(failed.next(), code("INVALID_ARGUMENT"));
    await assert.rejects(stream.watch(request("openfail")), code("INVALID_ARGUMENT"));
    await assert.rejects(unary.echo(request("subscribe")), code("WRONG_METHOD_KIND"));
  } finally {
    await fixture.close();
  }
});

test("worker unary timeout retains execution admission until the handler actually settles", async () => {
  const fixture = await workerFixture({ concurrency: 1, timeoutMs: 30 });
  try {
    const { unary } = clients(fixture.host);
    const pending = assert.rejects(unary.echo(request("wait")), code("TIMEOUT"));
    await fixture.wait("unary");
    await pending;
    await assert.rejects(unary.echo(request()), code("CONCURRENCY_FULL"));
    fixture.release("unary");
    // Control messages and requests use separate ports; release is not a cleanup acknowledgement.
    assert.deepEqual(await afterAdmissionReleased(() => unary.echo(request()), "CONCURRENCY_FULL"), request());
  } finally {
    await fixture.close();
  }
});

test("pending open and next cancel independently while uncooperative work retains worker quota", async () => {
  for (const [text, event] of [
    ["openwait", "opening"],
    ["nextwait", "producing"],
    ["returnwait", "returning"],
  ] as const) {
    const fixture = await workerFixture({ maxStreams: 1 });
    try {
      const { stream } = clients(fixture.host);
      const controller = new AbortController();
      const opening = stream.watch(request(text), { signal: controller.signal });
      let pending: Promise<unknown>;
      if (text === "openwait") pending = assert.rejects(opening, code("CANCELLED"));
      else {
        const source = await opening;
        pending = text === "nextwait" ? assert.rejects(source.next(), code("CANCELLED")) : Promise.resolve();
      }
      if (text !== "returnwait") await fixture.wait(event);
      controller.abort();
      await pending;
      if (text !== "openwait") await fixture.wait(text === "returnwait" ? "returning" : "aborted");
      await assert.rejects(stream.watch(request()), code("RESOURCE_EXHAUSTED"));
      fixture.release(event);
      await fixture.wait("returned");
      // The iterator's return notification precedes the framework's admission cleanup.
      const replacement = await afterAdmissionReleased(() => stream.watch(request()), "RESOURCE_EXHAUSTED");
      await replacement.cancel();
    } finally {
      await fixture.close();
    }
  }
});

test("worker nested calls preserve permissions and a child stream outlives parent unary", async () => {
  const fixture = await workerFixture();
  fixture.host.registerOwner("peer", [
    ...bindHandlers(PeerFixture, { echo: (p) => p }),
    ...bindStreamHandlers(PeerFixture, {
      watch: async function* (p) {
        yield create(ChangedSchema, { value: p });
      },
    }),
  ]);
  try {
    const { unary, stream } = clients(fixture.host);
    assert.deepEqual(await unary.echo(request("relay")), request("relay"));
    const nested = await stream.watch(request("relay"));
    assert.equal((await nested.next()).value?.value?.text, "relay");
    await nested.cancel();
    const restricted = fixture.host.client({
      caller: "limited",
      trusted: false,
      invoke: [methodRoute(Fixture.method.echo).name, methodRoute(Fixture.method.watch).name],
    });
    await assert.rejects(bindClient(Fixture, restricted).echo(request("relay")), code("UNAUTHORIZED"));
    await assert.rejects(bindStreamClient(Fixture, restricted).watch(request("relay")), code("UNAUTHORIZED"));
    await unary.echo(request("child-open"));
    assert.equal((await unary.echo(request("child-next"))).text, "child-open");
    await unary.echo(request("child-close"));
  } finally {
    await fixture.close();
  }
});

test("worker replacement and exit end old calls without unregistering the new owner", async () => {
  const first = await workerFixture();
  const second = await workerFixture({}, first.host);
  try {
    await first.close();
    const { unary, stream } = clients(second.host);
    await unary.echo(request());
    const source = await stream.watch(request("wait"));
    const pending = assert.rejects(source.next(), code("OWNER_UNAVAILABLE"));
    await second.wait("next");
    await second.worker.terminate();
    await pending;
    await source.closed;
  } finally {
    await second.close();
  }
});

test("worker manifest conflict and startup failure roll back without replacing local owner", async () => {
  const host = new GatewayHost();
  host.registerOwner("local", bindHandlers(Fixture, { echo: (p) => p }));
  const worker = new Worker(new URL("./fixtures/worker.mjs", import.meta.url), { execArgv: [] });
  await assert.rejects(attachWorker(host, "conflict", worker), code("CONFLICT"));
  assert.equal(worker.threadId, -1);
  assert.deepEqual(await clients(host).unary.echo(request()), request());
  const broken = new Worker("throw new Error('test startup');", { eval: true });
  await assert.rejects(attachWorker(host, "broken", broken), code("OWNER_UNAVAILABLE"));
});

test("worker CPU blockage does not block main; transport timeout ends waiting", async () => {
  const fixture = await workerFixture({ timeoutMs: 20 });
  fixture.host.registerOwner("peer", bindHandlers(PeerFixture, { echo: (p) => p }));
  try {
    const { unary } = clients(fixture.host);
    const pending = assert.rejects(unary.echo(request("block")), code("TIMEOUT"));
    await fixture.wait("blocking");
    const peer = bindClient(PeerFixture, fixture.host.client({ caller: "main", trusted: true }));
    assert.deepEqual(await peer.echo(request()), request());
    await pending;
  } finally {
    await fixture.close();
  }
});

test("worker caller cleanup, size and idle deadlines terminate streams", async () => {
  const fixture = await workerFixture({ consumerIdleMs: 30, maxChunkBytes: 128 });
  try {
    const { stream } = clients(fixture.host);
    const idle = await stream.watch(request());
    await idle.closed;
    await assert.rejects(idle.next(), code("TIMEOUT"));
    const large = await stream.watch(create(EnvelopeSchema, { id: 1n, text: "x".repeat(200) }));
    await assert.rejects(large.next(), code("RESOURCE_EXHAUSTED"));
    const waiting = await stream.watch(request("wait"));
    const pending = assert.rejects(waiting.next(), code("CANCELLED"));
    await fixture.wait("next");
    fixture.host.cleanupCaller("main");
    await pending;
    await waiting.closed;
  } finally {
    await fixture.close();
  }
});

test("close shares one promise and terminates an uncooperative worker after cleanup timeout", async () => {
  const fixture = await workerFixture({ timeoutMs: 30 });
  const { unary } = clients(fixture.host);
  const pending = assert.rejects(unary.echo(request("wait")), code("OWNER_UNAVAILABLE"));
  await fixture.wait("unary");
  const closing = fixture.handle.close();
  assert.equal(fixture.handle.close(), closing);
  await assert.rejects(closing, code("TIMEOUT"));
  await pending;
  assert.equal(fixture.worker.threadId, -1);
  await fixture.close().catch(() => {});
});

// A deliberately hostile endpoint speaks the same small control protocol; it has no host context capability.
function wireWorker(mode: string, token?: string) {
  return new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    let generation;
    let invocation;
    let expiredToken;
    const route = ${JSON.stringify(methodRoute(Fixture.method.echo))};
    parentPort.on('message', (frame) => {
      if (frame.kind === 'response') {
        if (invocation) parentPort.postMessage({ ...invocation, kind: 'response', result: frame.result });
        return;
      }
      if (frame.kind !== 'request') return;
      generation = frame.generation;
      const respond = (value) => parentPort.postMessage({ ...frame, kind: 'response', result: { ok: true, value } });
      const command = frame.command;
      if (command.op === 'hello') {
        respond({ routes: [{ ...route, timeoutMs: 100, maxConcurrency: 1 }],
          events: workerData.mode === 'events' ? [{ name: 'testing.Changed', policy: 'ordered' }] : [] });
      } else if (command.op === 'activate') {
        if (workerData.mode === 'activation') {
          parentPort.postMessage({ ...frame, kind: 'response',
            result: { ok: false, error: { code: 'HANDLER_ERROR', message: 'activation failed' } } });
        } else respond();
      } else if (command.op === 'close') respond();
      else if (command.op === 'invoke') {
        if (workerData.mode === 'expired' && !expiredToken) {
          expiredToken = command.context.token;
          respond(new Uint8Array());
        } else if (workerData.mode === 'damage') parentPort.postMessage({ invalid: true });
        else if (workerData.mode === 'bytes') respond('not bytes');
        else if (workerData.mode === 'token') respond(new TextEncoder().encode(command.context.token));
        else {
          invocation = frame;
          parentPort.postMessage({ version: 1, generation, id: 999, kind: 'request', command: {
            op: 'invoke', route, payload: command.payload,
            context: { token: workerData.mode === 'permissions' ? command.context.token
              : expiredToken || workerData.token || 'forged',
              ...(workerData.mode === 'permissions' ? { permissions: { caller: 'admin', trusted: true } } : {}) },
          } });
        }
      }
    });
  `,
    { eval: true, workerData: { mode, token } },
  );
}

test("worker malformed frames, event exports and forged callback metadata fail explicitly", async () => {
  for (const [mode, expected] of [
    ["damage", "INCOMPATIBLE"],
    ["bytes", "INCOMPATIBLE"],
    ["forged", "UNAUTHORIZED"],
    ["permissions", "UNAUTHORIZED"],
  ] as const) {
    const host = new GatewayHost();
    const worker = wireWorker(mode);
    const handle = await attachWorker(host, "wire", worker);
    try {
      await assert.rejects(clients(host).unary.echo(request()), code(expected));
    } finally {
      await handle.close().catch(() => {});
    }
  }
  const host = new GatewayHost();
  const local = host.registerOwner("wire", bindHandlers(Fixture, { echo: (p) => p }));
  for (const [mode, expected] of [
    ["events", "WRONG_METHOD_KIND"],
    ["activation", "HANDLER_ERROR"],
  ] as const) {
    const worker = wireWorker(mode);
    await assert.rejects(attachWorker(host, "wire", worker), code(expected));
    assert.deepEqual(await clients(host).unary.echo(request()), request());
  }
  local.close();
});

test("worker context tokens expire and cannot be reused on another connection", async () => {
  const host = new GatewayHost();
  const first = await attachWorker(host, "wire", wireWorker("token"));
  const caller = host.client({ caller: "main", trusted: true });
  const token = new TextDecoder().decode(await caller.invoke(methodRoute(Fixture.method.echo), new Uint8Array()));
  await first.close();
  const expired = await attachWorker(host, "wire", wireWorker("expired"));
  await caller.invoke(methodRoute(Fixture.method.echo), new Uint8Array());
  await assert.rejects(clients(host).unary.echo(request()), code("UNAUTHORIZED"));
  await expired.close();
  const second = await attachWorker(host, "wire", wireWorker("forged", token));
  try {
    await assert.rejects(clients(host).unary.echo(request()), code("UNAUTHORIZED"));
  } finally {
    await second.close();
  }
});

test("worker pending requests are bounded and cleanup remains available when full", async () => {
  const fixture = await workerFixture({ concurrency: 1000, timeoutMs: 5000 });
  try {
    const { unary, stream } = clients(fixture.host);
    const source = await stream.watch(request());
    const pending = Array.from({ length: 256 }, () => unary.echo(request("wait")));
    await assert.rejects(unary.echo(request()), code("RESOURCE_EXHAUSTED"));
    await source.cancel();
    for (let i = 0; i < 256; i++) await fixture.wait("unary");
    fixture.release("unary");
    await Promise.all(pending);
    const raw = fixture.host.client({ caller: "main", trusted: true });
    await assert.rejects(
      raw.invoke(methodRoute(Fixture.method.echo), new Uint8Array(64 * 1024 * 1024 + 1)),
      code("RESOURCE_EXHAUSTED"),
    );
    assert.deepEqual(await unary.echo(request()), request());
  } finally {
    await fixture.close();
  }
});

test("worker endpoint validates route kind and authenticated control metadata", async () => {
  const worker = new Worker(new URL("./fixtures/worker.mjs", import.meta.url), { execArgv: [] });
  const connection = new Connection(worker, randomUUID(), async () => {
    throw new Error("unexpected callback");
  });
  let accepted = 0;
  worker.on("message", (frame) => {
    if (frame.kind === "accepted") accepted++;
  });
  const context = { token: "test", permissions: { caller: "test", trusted: true } };
  const route = methodRoute(Fixture.method.echo);
  try {
    await connection.request({ op: "hello" }, 5000);
    await connection.request({ op: "activate" }, 5000);
    await assert.rejects(
      connection.request(
        { op: "invoke", route: { ...route, name: "testing.Unknown" }, payload: new Uint8Array(), context },
        1000,
      ),
      code("UNKNOWN_ROUTE"),
    );
    await assert.rejects(
      connection.request(
        { op: "invoke", route: methodRoute(Fixture.method.watch), payload: new Uint8Array(), context },
        1000,
      ),
      code("WRONG_METHOD_KIND"),
    );
    await assert.rejects(
      connection.request({ op: "stream.open", stream: "wrong-kind", route, payload: new Uint8Array(), context }, 1000),
      code("WRONG_METHOD_KIND"),
    );
    await assert.rejects(
      connection.request({ op: "invoke", route, payload: new Uint8Array(), context: { token: "missing" } }, 1000),
      code("UNAUTHORIZED"),
    );
    assert.equal(accepted, 0);
  } finally {
    await connection.request({ op: "close" }, 1500);
    await worker.terminate();
    connection.close();
  }
});

test("worker execution quota is independent of main local service execution", async () => {
  const fixture = await workerFixture({ maxStreams: 1 });
  fixture.host.registerOwner(
    "local",
    bindStreamHandlers(PeerFixture, {
      watch: async function* (request) {
        yield create(ChangedSchema, { value: request });
      },
    }).map((r) => ({ ...r, streamPolicy: { maxCallerStreams: 1 } })),
  );
  const caller = fixture.host.client({ caller: "main", trusted: true });
  const local = await bindStreamClient(PeerFixture, caller).watch(request());
  try {
    const remote = await bindStreamClient(Fixture, caller).watch(request());
    assert.equal((await remote.next()).value?.value?.id, 0n);
    await remote.cancel();
  } finally {
    await local.cancel();
    await fixture.close();
  }
});

test("worker opening uses its declared budget beyond the former 15 second transport default", async (t) => {
  const fixture = await workerFixture({ openTimeoutMs: 20_000 });
  try {
    const accepted = new Promise<void>((resolve) => {
      const listener = (frame: { kind: string }) => {
        if (frame.kind !== "accepted") return;
        fixture.worker.off("message", listener);
        resolve();
      };
      fixture.worker.on("message", listener);
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opening = clients(fixture.host).stream.watch(request("openwait"));
    void opening.catch(() => {});
    await Promise.all([accepted, fixture.wait("opening")]);
    t.mock.timers.tick(16_000);
    fixture.release("opening");
    const stream = await opening;
    await stream.cancel();
  } finally {
    t.mock.timers.reset();
    await fixture.close();
  }
});

test("nested worker unary uses the main service budget beyond the former 31 second default", async () => {
  const fixture = await workerFixture({ timeoutMs: 60_000, fakeTimers: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.host.registerOwner(
    "slow-peer",
    bindHandlers(PeerFixture, {
      echo: async (request) => {
        await gate;
        return request;
      },
    }).map((r) => ({ ...r, timeoutMs: 60_000 })),
  );
  try {
    const pending = clients(fixture.host).unary.echo(request("relay"));
    void pending.catch(() => {});
    await fixture.wait("budget");
    fixture.advance(32_000);
    await fixture.wait("advanced");
    release();
    assert.deepEqual(await pending, request("relay"));
  } finally {
    release();
    await fixture.close();
  }
});
