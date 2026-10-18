import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ChangedSchema,
  EmptySchema,
  EnvelopeSchema,
  Fixture,
  PeerFixture,
} from "xiaowei-contracts";
import {
  bindClient,
  bindEvent,
  bindHandlers,
  bindStreamClient,
  bindStreamHandlers,
  methodRoute,
} from "../src/binding/index.js";
import { GatewayFailure } from "../src/core/protocol.js";
import { GatewayHost } from "../src/core/registry.js";
import { connectWebSocket } from "../src/websocket/peer.js";

const directory = mkdtempSync(join(tmpdir(), "xw-websocket-"));
let server: ChildProcess;
let url: string;
let diagnostics = "";
const code = (value: string) => (error: unknown) =>
  error instanceof GatewayFailure && error.detail.code === value;
const request = (text = "", id = 42n) => create(EnvelopeSchema, { text, id });

before(async () => {
  execFileSync(
    "go",
    ["build", "-race", "-o", join(directory, "fixture"), "./internal/gateway/testfixture"],
    { cwd: new URL("../../../server", import.meta.url), stdio: "inherit", timeout: 120_000 },
  );
  server = spawn(join(directory, "fixture"), [], { stdio: ["pipe", "pipe", "pipe"] });
  server.stderr?.on("data", (data: Buffer) => {
    diagnostics += data.toString();
  });
  url = await new Promise<string>((resolve, reject) => {
    const reader = createInterface({
      input:
        server.stdout ??
        (() => {
          throw new Error("missing fixture stdout");
        })(),
    });
    const timer = setTimeout(() => reject(new Error("fixture startup timeout")), 5000);
    reader.once("line", (line) => {
      clearTimeout(timer);
      reader.close();
      resolve(line);
    });
    server.once("error", reject);
  });
});
after(async () => {
  try {
    server?.stdin?.end();
    if (server && server.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.kill();
          resolve();
        }, 5000);
        server.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    assert.equal(diagnostics.includes("DATA RACE"), false, diagnostics);
    assert.equal(server.exitCode, 0, diagnostics);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const host = new GatewayHost();
  const owner = host.registerOwner(
    "callbacks",
    [
      ...bindHandlers(PeerFixture, { echo: (input) => ({ ...input, text: "callback-ok" }) }),
      ...bindStreamHandlers(PeerFixture, {
        async *watch() {
          for (let i = 0n; i < 3n; i++)
            yield create(ChangedSchema, { value: request("reverse", i) });
        },
      }),
    ],
    [bindEvent(ChangedSchema, EmptySchema, "ordered", () => true)],
  );
  const peer = await connectWebSocket({
    url,
    token: "fixture",
    exports: { host, manifest: owner.manifest },
  });
  return {
    host,
    owner,
    peer,
    api: bindClient(Fixture, peer.client),
    stream: bindStreamClient(Fixture, peer.client),
  };
}

test("real TS/Go binary PB, bidirectional calls, routing and bounded payloads", {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  try {
    const input = request("中文", 18446744073709551615n);
    input.blobs = [
      { $typeName: "testing.Envelope.Blob", data: new Uint8Array(2 * 1024 * 1024).fill(173) },
    ];
    assert.deepEqual(await f.api.echo(input), input);
    assert.equal((await f.api.echo(request("callback"))).text, "callback-ok");
    assert.equal((await f.api.echo(request("reverse-stream"))).id, 3n);
    await assert.rejects(f.api.echo(request("failure")), code("INVALID_ARGUMENT"));
    const route = methodRoute(Fixture.method.echo);
    assert.equal(f.peer.canInvoke(route), true);
    assert.equal(f.peer.canInvoke({ ...route, output: "wrong.Output" }), false);
    assert.equal(f.peer.canInvoke({ ...route, name: "local.Storage.Get" }), false);
    await assert.rejects(
      f.peer.client.invoke({ ...route, output: "wrong.Output" }, new Uint8Array()),
      code("INCOMPATIBLE"),
    );
    await assert.rejects(
      f.peer.client.invoke({ ...route, name: "local.Storage.Get" }, new Uint8Array()),
      code("UNKNOWN_ROUTE"),
    );
    await assert.rejects(
      f.peer.client.invoke(route, new Uint8Array(8 * 1024 * 1024 + 1)),
      code("RESOURCE_EXHAUSTED"),
    );
    await f.peer.ping();
    f.peer.close();
    assert.equal(f.peer.canInvoke(route), false);
  } finally {
    f.peer.close();
  }
});

test("real response streams interleave, cancel pending work and report producer/idle failure", {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  try {
    const a = await f.stream.watch(request());
    const b = await f.stream.watch(request());
    for (let i = 1n; i <= 3n; i++) {
      assert.equal((await a.next()).value?.value?.id, i);
      assert.equal((await b.next()).value?.value?.id, i);
    }
    assert.equal((await a.next()).done, true);
    assert.equal((await b.next()).done, true);
    const failed = await f.stream.watch(request("fail"));
    await failed.next();
    await assert.rejects(failed.next(), code("INVALID_ARGUMENT"));
    const blocked = await f.stream.watch(request("nextwait"));
    const pending = assert.rejects(blocked.next());
    await blocked.cancel();
    await pending;
    const idle = await f.stream.watch(request());
    await idle.closed;
    await assert.rejects(idle.next(), code("TIMEOUT"));
    const controller = new AbortController();
    const open = assert.rejects(f.stream.watch(request("openwait"), { signal: controller.signal }));
    controller.abort();
    await open;
    await delay(20);
    assert.equal((await f.api.echo(request("active"))).id, 0n);
  } finally {
    f.peer.close();
  }
});

test("real event subscription ready, filter, acknowledged delivery and unsubscribe", {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  try {
    const events: bigint[] = [];
    let received!: () => void;
    const delivered = new Promise<void>((resolve) => {
      received = resolve;
    });
    const subscription = await f.peer.client.subscribe(
      ChangedSchema.typeName,
      toBinary(EnvelopeSchema, request("", 9n)),
      (bytes) => {
        const value = fromBinary(ChangedSchema, bytes).value;
        assert.ok(value);
        events.push(value.id);
        received();
      },
    );
    await f.api.echo(request("publish", 8n));
    await f.api.echo(request("publish", 9n));
    await delivered;
    assert.deepEqual(events, [9n]);
    await assert.rejects(
      f.peer.client.subscribe(ChangedSchema.typeName, Uint8Array.of(255), () => {}),
      code("INVALID_ARGUMENT"),
    );
    await f.api.echo(request("subscribe"));
    f.owner.publish(
      ChangedSchema.typeName,
      toBinary(ChangedSchema, create(ChangedSchema, { value: request() })),
    );
    const deadline = Date.now() + 2000;
    while ((await f.api.echo(request("eventcount"))).id === 0n && Date.now() < deadline)
      await delay(1);
    assert.equal((await f.api.echo(request("eventcount"))).id, 1n);
    subscription.close();
    await f.peer.ping();
    await f.api.echo(request("publish", 9n));
    await delay(20);
    assert.deepEqual(events, [9n]);
  } finally {
    f.peer.close();
  }
});

test("unary cancellation reaches actual Go work; connection close terminates pending operations", {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  try {
    const call = f.api.echo(request("wait"));
    const rejected = assert.rejects(call, code("CANCELLED"));
    call.cancel();
    await rejected;
    await f.peer.ping();
    assert.equal((await f.api.echo(request("active"))).id, 0n);
    const pending = assert.rejects(f.api.echo(request("wait")), code("OWNER_UNAVAILABLE"));
    f.peer.close();
    await pending;
  } finally {
    f.peer.close();
  }
});

test("connection authentication required", { timeout: 10_000 }, async () => {
  await assert.rejects(
    connectWebSocket({
      url,
      token: "wrong",
      exports: {
        host: new GatewayHost(),
        manifest: { routes: [], events: [] },
      },
    }),
  );
});

test("network event delivery has a finite queue even when its consumer stops draining", {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  try {
    await f.api.echo(request("subscribe"));
    for (let i = 0; i < 32; i++) {
      f.owner.publish(
        ChangedSchema.typeName,
        toBinary(ChangedSchema, create(ChangedSchema, { value: request() })),
      );
    }
    await assert.rejects(f.api.echo(request()), code("OWNER_UNAVAILABLE"));
  } finally {
    f.peer.close();
  }
});
