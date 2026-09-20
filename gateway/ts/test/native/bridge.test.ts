import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, PeerFixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, methodRoute } from "../../src/binding/index.js";
import { GatewayFailure } from "../../src/core/protocol.js";
import { GatewayHost } from "../../src/core/registry.js";
import { attachNative, type NativeEndpoint } from "../../src/main/native.js";

interface FixtureEndpoint extends NativeEndpoint {
  fixtureInvoke(route: string, bytes: Buffer): Promise<Buffer | string>;
  fixturePublish(bytes: Buffer): Promise<Buffer | string>;
  fixtureSubscribe(filter: Buffer | null): Promise<Buffer | string>;
  fixtureUnsubscribe(): void;
  fixtureNext(): Promise<Buffer | string>;
  fixtureRelease(): void;
}
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
function binary(name: string): string {
  const directory = `${root}tests/native/${name}`;
  return `${directory}/${readdirSync(directory).find((name) => name.endsWith(".node"))}`;
}
const search = require(binary("search")) as {
  createGatewayFixture(): FixtureEndpoint;
  createGatewayEndpoint(): FixtureEndpoint;
};
const clipboard = require(binary("clipboard")) as typeof search;
const echo = methodRoute(Fixture.method.echo);
const peerEcho = methodRoute(PeerFixture.method.echo);
const bytes = (text = "", data = new Uint8Array()) =>
  Buffer.from(toBinary(EnvelopeSchema, create(EnvelopeSchema, { text, id: 0xffffffffffffffffn, blobs: [{ data }] })));
const changed = (id: bigint) => Buffer.from(toBinary(ChangedSchema, create(ChangedSchema, { value: { id } })));
const read = (reply: Buffer | string) => {
  if (typeof reply === "string") throw new GatewayFailure(JSON.parse(reply));
  return reply;
};
const isCode = (code: string) => (error: unknown) => error instanceof GatewayFailure && error.detail.code === code;
async function attachPair() {
  const host = new GatewayHost();
  const a = search.createGatewayFixture();
  const b = clipboard.createGatewayFixture();
  const aHandle = await attachNative(host, "a", a);
  const bHandle = await attachNative(host, "b", b);
  return {
    host,
    a,
    b,
    async close() {
      await Promise.all([aHandle.close(), bHandle.close()]);
    },
  };
}

test("two real addons: local hit, bidirectional calls, PB bytes, reentry and concurrency boundary", async () => {
  const { host, a, b, close } = await attachPair();
  try {
    const payload = bytes(
      "",
      Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 256),
    );
    // Own-route fallback is rejected by the host, so success proves local dispatch stayed in Rust.
    assert.deepEqual(read(await a.fixtureInvoke(JSON.stringify(echo), payload)), payload);
    assert.deepEqual(read(await a.fixtureInvoke(JSON.stringify(peerEcho), payload)), payload);
    assert.deepEqual(read(await b.fixtureInvoke(JSON.stringify(echo), payload)), payload);
    const response = read(await a.fixtureInvoke(JSON.stringify(echo), bytes("relay")));
    assert.equal(fromBinary(EnvelopeSchema, response).text, "done");
    const caller = host.client({ caller: "main", trusted: true });
    const typed = bindClient(Fixture, caller);
    assert.equal((await typed.echo(create(EnvelopeSchema, { id: 99n }))).id, 99n);
    const cycle = readError(await a.fixtureInvoke(JSON.stringify(echo), bytes("cycle")));
    assert.ok(["CONCURRENCY_FULL", "TIMEOUT"].includes(cycle));
    assert.equal(readError(await a.fixtureInvoke(JSON.stringify(echo), Buffer.from([255]))), "INVALID_ARGUMENT");
    assert.equal(
      readError(await a.fixtureInvoke(JSON.stringify({ ...echo, name: "unknown.route" }), bytes())),
      "UNKNOWN_ROUTE",
    );
  } finally {
    await close();
  }
});
function readError(reply: Buffer | string): string {
  assert.equal(typeof reply, "string");
  return JSON.parse(reply as string).code;
}

test("pending native handler permits independent control calls and close ends pending requests", async () => {
  const { host, a, b, close } = await attachPair();
  try {
    const pending = a.fixtureInvoke(JSON.stringify(echo), bytes("wait"));
    await delay(10);
    a.fixtureRelease();
    assert.equal(fromBinary(EnvelopeSchema, read(await pending)).text, "wait");
    assert.equal(readError(await a.fixtureInvoke(JSON.stringify(echo), bytes("wait"))), "TIMEOUT");
    const stillRunning = a.fixtureInvoke(JSON.stringify(echo), bytes("wait"));
    await delay(10);
    const third = await a.fixtureInvoke(JSON.stringify(echo), bytes());
    assert.equal(readError(third), "CONCURRENCY_FULL");
    await a.close();
    assert.equal(readError(await stillRunning), "OWNER_UNAVAILABLE");
    const caller = host.client({ caller: "main", trusted: true });
    await assert.rejects(caller.invoke(echo, bytes()), isCode("UNKNOWN_ROUTE"));
    a.fixtureRelease();
    a.fixtureRelease();
    // B can still make an independent call after A closes.
    read(await b.fixtureInvoke(JSON.stringify(peerEcho), bytes()));
  } finally {
    await close();
  }
});

test("native event source → native subscriber, filter, unsubscribe and owner reconnect", async () => {
  const pair = await attachPair();
  let replacement: FixtureEndpoint | undefined;
  let replacementHandle: Awaited<ReturnType<typeof attachNative>> | undefined;
  try {
    read(await pair.b.fixtureSubscribe(Buffer.from(toBinary(EnvelopeSchema, create(EnvelopeSchema, { id: 2n })))));
    read(await pair.a.fixturePublish(changed(1n)));
    read(await pair.a.fixturePublish(changed(2n)));
    assert.deepEqual(read(await pair.b.fixtureNext()), changed(2n));
    await pair.a.close();
    replacement = search.createGatewayFixture();
    replacementHandle = await attachNative(pair.host, "a", replacement);
    await delay(10);
    read(await replacement.fixturePublish(changed(3n)));
    assert.deepEqual(read(await pair.b.fixtureNext()), changed(3n));
    assert.equal(readError(await pair.a.fixturePublish(changed(9n))), "OWNER_UNAVAILABLE");
    pair.b.fixtureUnsubscribe();
    await delay(10);
    read(await replacement.fixturePublish(changed(4n)));
    assert.equal(readError(await pair.b.fixtureNext()), "TIMEOUT");
  } finally {
    await pair.close();
    await replacementHandle?.close();
  }
});

test("manifest conflicts roll back endpoint; same-name reconnection cannot be closed by stale handle", async () => {
  const host = new GatewayHost();
  const local = host.registerOwner("ts", bindHandlers(Fixture, { echo: (p) => p }));
  const conflict = search.createGatewayFixture();
  await assert.rejects(attachNative(host, "native", conflict), isCode("CONFLICT"));
  assert.equal(readError(await conflict.fixtureInvoke(JSON.stringify(echo), bytes())), "OWNER_UNAVAILABLE");
  local.close();
  const first = search.createGatewayFixture();
  const old = await attachNative(host, "native", first);
  const duplicate = search.createGatewayFixture();
  await assert.rejects(attachNative(host, "another", duplicate), isCode("CONFLICT"));
  const second = search.createGatewayFixture();
  const current = await attachNative(host, "native", second);
  await old.close();
  read(await second.fixtureInvoke(JSON.stringify(echo), bytes()));
  await current.close();
});

test("source permissions survive native reentry and cannot be supplied in PB payload", async () => {
  const { host, close } = await attachPair();
  try {
    const restricted = host.client({ caller: "plugin", trusted: false, invoke: [echo.name] });
    await assert.rejects(restricted.invoke(echo, bytes("relay")), isCode("UNAUTHORIZED"));
    const trusted = host.client({ caller: "main", trusted: true });
    read(Buffer.from(await trusted.invoke(echo, bytes("relay"))));
  } finally {
    await close();
  }
});

test("callback Promise rejection, synchronous throw, queue full and callback close are explicit", async () => {
  for (const mode of ["reject", "throw", "pending", "echo"] as const) {
    const endpoint = search.createGatewayEndpoint();
    endpoint.bind(
      (_control, payload) => {
        if (mode === "throw") throw new Error("private message");
        if (mode === "reject") return Promise.reject("private message");
        if (mode === "pending") return new Promise(() => {});
        return Promise.resolve(payload);
      },
      JSON.stringify({ token: "test", trusted: true }),
    );
    read(await endpoint.activate());
    const calls = Array.from({ length: mode === "echo" ? 512 : 1 }, () =>
      endpoint.fixtureInvoke(JSON.stringify(echo), bytes()),
    );
    if (mode === "pending") await endpoint.close();
    const results = await Promise.all(calls);
    if (mode === "echo") {
      assert.ok(results.some((r) => typeof r === "string" && readError(r) === "CONCURRENCY_FULL"));
      for (const result of results) if (typeof result !== "string") assert.deepEqual(result, bytes());
    } else
      for (const result of results) {
        assert.equal(readError(result), mode === "pending" ? "OWNER_UNAVAILABLE" : "HANDLER_ERROR");
      }
    await endpoint.close();
  }
});

test("native Node child closes explicitly and exits without process.exit or leaked callbacks", () => {
  const script = `
    const native = require(${JSON.stringify(binary("search"))});
    (async () => {
      const endpoint = native.createGatewayEndpoint();
      endpoint.bind(async (_, bytes) => bytes, JSON.stringify({token:'origin',trusted:true}));
      await endpoint.activate();
      await endpoint.fixtureInvoke(${JSON.stringify(JSON.stringify(echo))}, Buffer.from([0,255]));
      await endpoint.close();
      console.log('closed');
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /closed/);
});

test("reservation does not publish early and failed activation preserves the running owner", async () => {
  const host = new GatewayHost();
  const endpoint = search.createGatewayFixture();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new Proxy(endpoint, {
    get(target, key) {
      if (key === "activate")
        return async () => {
          await gate;
          return target.activate();
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const attaching = attachNative(host, "a", delayed);
  assert.equal(
    (
      await host.invoke(
        (await import("../../src/core/registry.js")).createContext({ caller: "main", trusted: true }),
        echo,
        bytes(),
      )
    ).ok,
    false,
  );
  assert.throws(() => host.registerOwner("other", bindHandlers(Fixture, { echo: (p) => p })), isCode("CONFLICT"));
  assert.equal(readError(await endpoint.fixtureInvoke(JSON.stringify(echo), bytes())), "OWNER_UNAVAILABLE");
  release();
  const handle = await attaching;
  const replacement = search.createGatewayFixture();
  const broken = new Proxy(replacement, {
    get(target, key) {
      if (key === "activate")
        return async () => JSON.stringify({ code: "HANDLER_ERROR", message: "test activation failure" });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(attachNative(host, "a", broken), isCode("HANDLER_ERROR"));
  read(await endpoint.fixtureInvoke(JSON.stringify(echo), bytes()));
  assert.equal(readError(await replacement.fixtureInvoke(JSON.stringify(echo), bytes())), "OWNER_UNAVAILABLE");
  await handle.close();
});

test("native subscriber can precede source registration; Ordered burst is delivered once", async () => {
  const host = new GatewayHost();
  const b = clipboard.createGatewayFixture();
  const subscriber = await attachNative(host, "b", b);
  let source: Awaited<ReturnType<typeof attachNative>> | undefined;
  try {
    read(await b.fixtureSubscribe(null));
    const a = search.createGatewayFixture();
    source = await attachNative(host, "a", a);
    await delay(10);
    for (let id = 0; id < 256; id++) read(await a.fixturePublish(changed(BigInt(id))));
    for (let id = 0; id < 256; id++) assert.deepEqual(read(await b.fixtureNext()), changed(BigInt(id)));
  } finally {
    await source?.close();
    await subscriber.close();
  }
});

test("worker environment shutdown settles native pending work without retaining the process", () => {
  const workerScript = `
    const { parentPort } = require('node:worker_threads');
    const native = require(${JSON.stringify(binary("search"))});
    (async () => {
      const endpoint = native.createGatewayEndpoint();
      endpoint.bind(() => new Promise(() => {}), JSON.stringify({token:'origin',trusted:true}));
      await endpoint.activate();
      endpoint.fixtureInvoke(${JSON.stringify(JSON.stringify(echo))}, Buffer.from([0,255]));
      parentPort.postMessage('pending');
    })();
  `;
  const script = `
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(${JSON.stringify(workerScript)}, { eval: true });
    worker.once('message', async () => { await worker.terminate(); console.log('terminated'); });
  `;
  const result = spawnSync(process.execPath, ["-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /terminated/);
});
