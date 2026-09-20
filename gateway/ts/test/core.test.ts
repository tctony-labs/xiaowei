import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindClient, bindEvent, bindHandlers, methodRoute, parseId } from "../src/binding/index.js";
import { type Backpressure, GatewayFailure, type Result } from "../src/core/protocol.js";
import { type CallContext, createContext, GatewayHost } from "../src/core/registry.js";

const route = methodRoute(Fixture.method.echo);
const context = createContext({ caller: "test", trusted: true });
const bytes = (id = 0n) => toBinary(EnvelopeSchema, create(EnvelopeSchema, { id }));
const changed = (id: bigint) => toBinary(ChangedSchema, create(ChangedSchema, { value: { id } }));
const handlers = () => bindHandlers(Fixture, { echo: (request) => request });
const client = (host: GatewayHost) => host.client({ caller: "test", trusted: true });
const exported = (policy: Backpressure) =>
  bindEvent(
    ChangedSchema,
    EnvelopeSchema,
    policy,
    (payload, filter) => !filter || (payload.value?.id ?? 0n) >= filter.id,
  );
function code(result: Result<unknown>): string {
  assert.equal(result.ok, false);
  return result.ok ? "" : result.error.code;
}
function rejectsCode(expected: string) {
  return (error: unknown) => error instanceof GatewayFailure && error.detail.code === expected;
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("owner registration is atomic across routes/events, duplicates and replacements", async () => {
  const host = new GatewayHost();
  const old = host.registerOwner("a", handlers(), [exported("ordered")]);
  assert.throws(() => host.registerOwner("b", handlers()), rejectsCode("CONFLICT"));
  assert.throws(() => host.registerOwner("a", [...handlers(), ...handlers()]), rejectsCode("CONFLICT"));
  assert.throws(
    () =>
      host.registerOwner("b", [{ route: { ...route, name: "new.route" }, handler: (p) => p }], [exported("ordered")]),
    rejectsCode("CONFLICT"),
  );
  assert.equal(code(await host.invoke(context, { ...route, name: "new.route" }, bytes())), "UNKNOWN_ROUTE");
  assert.deepEqual(await client(host).invoke(route, bytes()), bytes());
  const replacement = host.registerOwner("a", handlers());
  assert.notEqual(old.instance, replacement.instance);
  old.close();
  assert.deepEqual(await client(host).invoke(route, bytes()), bytes());
  replacement.close();
  replacement.close();
  assert.equal(code(await host.invoke(context, route, bytes())), "UNKNOWN_ROUTE");
});

test("typed PB binding preserves optional, oneof, uint64 and nested bytes; rejects invalid wire", async () => {
  const host = new GatewayHost();
  host.registerOwner("a", handlers());
  const bound = bindClient(Fixture, client(host));
  const input = create(EnvelopeSchema, {
    id: parseId("18446744073709551615"),
    text: "中文🦀",
    label: "",
    value: { case: "nullValue", value: 0 },
    blobs: [{ data: new Uint8Array([0, 255, 1]) }],
  });
  assert.deepEqual(await bound.echo(input), input);
  assert.equal((await bound.echo(create(EnvelopeSchema))).label, undefined);
  assert.equal(code(await host.invoke(context, route, new Uint8Array([255]))), "INVALID_ARGUMENT");
  assert.equal(code(await host.invoke(context, route, null as unknown as Uint8Array)), "INVALID_ARGUMENT");
  for (const id of ["-1", "+1", "1.1", "18446744073709551616", ""]) assert.throws(() => parseId(id));
});

test("local hit does not forward, remote miss dispatches once and preserves raw unknown fields", async () => {
  const target = new GatewayHost();
  const endpoint = target.registerOwner("remote", handlers());
  let count = 0;
  const host = new GatewayHost(async (route, payload, context) => {
    count++;
    return endpoint.dispatchLocal(route, payload, context);
  });
  const input = new Uint8Array([...bytes(42n), 0x98, 0x06, 0x01]);
  assert.deepEqual(await client(host).invoke(route, input), input);
  assert.equal(count, 1);
  host.registerOwner("local", handlers());
  await client(host).invoke(route, bytes());
  assert.equal(count, 1);
  assert.equal(code(await host.invoke(context, { ...route, name: "missing.route" }, bytes())), "UNKNOWN_ROUTE");
  assert.equal(count, 2);
});

test("timeout retains admission until actual completion and owner close rejects pending", async () => {
  const host = new GatewayHost();
  const work = gate();
  const started = gate();
  const [echo] = handlers();
  assert.ok(echo);
  const owner = host.registerOwner("a", [
    {
      ...echo,
      timeoutMs: 10,
      maxConcurrency: 1,
      handler: async (payload) => {
        started.release();
        await work.promise;
        return payload;
      },
    },
  ]);
  const pending = host.invoke(context, route, bytes());
  await started.promise;
  assert.equal(code(await host.invoke(context, route, bytes())), "CONCURRENCY_FULL");
  assert.equal(code(await pending), "TIMEOUT");
  for (let i = 0; i < 5; i++) assert.equal(code(await host.invoke(context, route, bytes())), "CONCURRENCY_FULL");
  work.release();
  await tick();
  assert.deepEqual(await client(host).invoke(route, bytes()), bytes());
  owner.close();
  const slow = gate();
  const old = host.registerOwner("a", [
    {
      route,
      handler: async (p) => {
        await slow.promise;
        return p;
      },
    },
  ]);
  const stale = host.invoke(context, route, bytes(1n));
  const next = host.registerOwner("a", handlers());
  assert.equal(code(await stale), "OWNER_UNAVAILABLE");
  old.close();
  slow.release();
  assert.deepEqual(await client(host).invoke(route, bytes(2n)), bytes(2n));
  assert.equal(code(await old.dispatchLocal(route, bytes(), context)), "OWNER_UNAVAILABLE");
  next.close();
});

test("forwarding owner tracks lifetime but does not add execution limits", async () => {
  const host = new GatewayHost();
  const work = gate();
  let calls = 0;
  const owner = host.registerOwner("remote", [{ route, timeoutMs: 1, maxConcurrency: 1 }], [], async (_, p) => {
    calls++;
    await work.promise;
    return { ok: true, value: p };
  });
  const first = host.invoke(context, route, bytes());
  const second = host.invoke(context, route, bytes());
  assert.equal(calls, 2);
  owner.close();
  assert.equal(code(await first), "OWNER_UNAVAILABLE");
  assert.equal(code(await second), "OWNER_UNAVAILABLE");
  work.release();
});

test("trusted calls, exact authorization, forged context, nested calls and method compatibility", async () => {
  const host = new GatewayHost();
  const secret = { ...route, name: "testing.Secret" };
  host.registerOwner("a", [
    ...bindHandlers(Fixture, {
      echo: async (p, caller) => {
        await caller.invoke(secret, bytes());
        return p;
      },
    }),
    { route: secret, handler: (p) => p },
  ]);
  const restricted = host.client({ caller: "plugin", trusted: false, invoke: [route.name] });
  await assert.rejects(restricted.invoke(route, bytes()), rejectsCode("UNAUTHORIZED"));
  await client(host).invoke(route, bytes());
  const forged = { caller: "test", trusted: true } as unknown as CallContext;
  assert.equal(code(await host.invoke(forged, route, bytes())), "UNAUTHORIZED");
  assert.equal(code(await host.invoke(context, { ...route, contractVersion: 2 }, bytes())), "INCOMPATIBLE");
  assert.equal(code(await host.invoke(context, methodRoute(Fixture.method.watch), bytes())), "WRONG_METHOD_KIND");
  host.registerOwner("a", [
    {
      route,
      handler: () => {
        throw new Error("private payload must not leak");
      },
    },
  ]);
  assert.deepEqual(await host.invoke(context, route, bytes()), {
    ok: false,
    error: { code: "HANDLER_ERROR", message: "handler or transport failed" },
  });
});

test("event filters, explicit exports, caller cleanup and idempotent close", async () => {
  const host = new GatewayHost();
  const owner = host.registerOwner("a", [], [exported("ordered")]);
  const caller = client(host);
  await assert.rejects(
    () => caller.subscribe("testing.Changed", new Uint8Array([255]), () => {}),
    rejectsCode("INVALID_ARGUMENT"),
  );
  await assert.rejects(
    () => host.client({ caller: "plugin", trusted: false }).subscribe("testing.Changed", undefined, () => {}, true),
    rejectsCode("UNAUTHORIZED"),
  );
  assert.throws(() => owner.publish("unexported", bytes()), rejectsCode("UNKNOWN_ROUTE"));
  const received: Uint8Array[] = [];
  const subscription = await caller.subscribe("testing.Changed", bytes(2n), (p) => {
    received.push(p);
  });
  owner.publish("testing.Changed", changed(1n));
  owner.publish("testing.Changed", changed(2n));
  await tick();
  assert.deepEqual(received, [changed(2n)]);
  host.cleanupCaller("test");
  owner.publish("testing.Changed", changed(3n));
  await tick();
  assert.equal(received.length, 1);
  subscription.close();
  subscription.close();
});

test("Ordered burst, Coalesce latest and Drop first pending preserve per-subscription semantics", async () => {
  for (const policy of ["ordered", "coalesce", "drop"] as const) {
    const host = new GatewayHost();
    const owner = host.registerOwner("a", [], [exported(policy)]);
    const received: bigint[] = [];
    const subscription = await client(host).subscribe("testing.Changed", undefined, (p) => {
      received.push(fromBinary(ChangedSchema, p).value?.id ?? 0n);
    });
    for (let i = 0; i < 256; i++) owner.publish("testing.Changed", changed(BigInt(i)));
    await tick();
    assert.deepEqual(
      received,
      policy === "ordered" ? Array.from({ length: 256 }, (_, i) => BigInt(i)) : policy === "coalesce" ? [255n] : [0n],
    );
    subscription.close();
  }
});

test("late owner and re-registration restore subscription intent without replay or stale delivery", async () => {
  const host = new GatewayHost();
  const received: Uint8Array[] = [];
  const subscription = await client(host).subscribe(
    "testing.Changed",
    undefined,
    (p) => {
      received.push(p);
    },
    true,
  );
  const old = host.registerOwner("a", [], [exported("ordered")]);
  old.publish("testing.Changed", changed(1n));
  await tick();
  old.publish("testing.Changed", changed(2n));
  old.close();
  const next = host.registerOwner("a", [], [exported("ordered")]);
  assert.throws(() => old.publish("testing.Changed", changed(3n)), rejectsCode("OWNER_UNAVAILABLE"));
  next.publish("testing.Changed", changed(4n));
  await tick();
  assert.deepEqual(received, [changed(1n), changed(4n)]);
  subscription.close();
});

test("remote event endpoint validates filters at owner and late binding closes safely", async () => {
  const endpoint = new GatewayHost();
  const source = endpoint.registerOwner("source", [], [exported("ordered")]);
  const host = new GatewayHost();
  const received: Uint8Array[] = [];
  const registration = {
    name: "testing.Changed",
    policy: "ordered" as const,
    attach: (ctx: CallContext, filter: Uint8Array | undefined, sink: (p: Uint8Array) => void | Promise<void>) =>
      endpoint.subscribe(ctx, "testing.Changed", filter, sink),
  };
  const consumer = await client(host).subscribe(
    "testing.Changed",
    bytes(2n),
    (p) => {
      received.push(p);
    },
    true,
  );
  let owner = host.registerOwner("remote", [], [registration]);
  await tick();
  source.publish("testing.Changed", changed(1n));
  source.publish("testing.Changed", changed(2n));
  await tick();
  assert.deepEqual(received, [changed(2n)]);
  await assert.rejects(
    client(host).subscribe("testing.Changed", new Uint8Array([255]), () => {}),
    rejectsCode("INVALID_ARGUMENT"),
  );
  owner.close();
  source.publish("testing.Changed", changed(3n));
  await tick();
  owner = host.registerOwner("remote", [], [registration]);
  await tick();
  source.publish("testing.Changed", changed(4n));
  await tick();
  assert.deepEqual(received, [changed(2n), changed(4n)]);
  consumer.close();
  owner.close();
  source.close();

  const ready = gate();
  let closed = 0;
  host.registerOwner(
    "slow",
    [],
    [
      {
        name: "testing.Slow",
        policy: "ordered",
        attach: async () => {
          await ready.promise;
          return {
            close() {
              closed++;
            },
          };
        },
      },
    ],
  );
  const pending = client(host).subscribe("testing.Slow", undefined, () => {});
  host.cleanupCaller("test");
  ready.release();
  (await pending).close();
  assert.equal(closed, 1);
});

test("shared wire cases use the same contract in both languages", async () => {
  const { readFile } = await import("node:fs/promises");
  const cases = JSON.parse(await readFile(new URL("../../tests/wire-cases.json", import.meta.url), "utf8"));
  const host = new GatewayHost();
  host.registerOwner("fixture", handlers());
  for (const fixture of cases) {
    const result = await host.invoke(context, route, Uint8Array.from(fixture.payload));
    if (fixture.valid) {
      assert.equal(result.ok, true, fixture.name);
      if (result.ok) assert.equal(fromBinary(EnvelopeSchema, result.value).id.toString(), fixture.id);
    } else assert.equal(code(result), "INVALID_ARGUMENT", fixture.name);
  }
});

test("late failure from a replaced event endpoint cannot remove the new subscription", async () => {
  const host = new GatewayHost();
  const gateReady = gate();
  let deliver = (_p: Uint8Array) => {};
  host.registerOwner(
    "a",
    [],
    [
      {
        name: "testing.Late",
        policy: "ordered",
        attach: async () => {
          await gateReady.promise;
          throw new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "old connection closed" });
        },
      },
    ],
  );
  const received: Uint8Array[] = [];
  const pending = client(host).subscribe(
    "testing.Late",
    undefined,
    (p) => {
      received.push(p);
    },
    true,
  );
  host.registerOwner(
    "a",
    [],
    [
      {
        name: "testing.Late",
        policy: "ordered",
        attach: async (_, __, sink) => {
          deliver = sink;
          return { close() {} };
        },
      },
    ],
  );
  await tick();
  gateReady.release();
  const subscription = await pending;
  deliver(bytes(1n));
  await tick();
  assert.deepEqual(received, [bytes(1n)]);
  subscription.close();
});

test("owner manifest keeps default execution metadata without sharing mutable registration state", () => {
  const host = new GatewayHost();
  const registrations = handlers();
  const owner = host.registerOwner("a", registrations, [exported("ordered")]);
  assert.equal(owner.manifest.routes[0].timeoutMs, 30_000);
  assert.equal(owner.manifest.routes[0].maxConcurrency, 32);
  assert.ok(Object.isFrozen(owner.manifest.routes[0]));
  registrations[0].route = { ...route, name: "mutated.route" };
  assert.equal(owner.manifest.routes[0].name, route.name);
});
