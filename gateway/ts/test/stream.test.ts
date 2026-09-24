import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindStreamClient, bindStreamHandlers, methodRoute } from "../src/binding/index.js";
import { createContext, GatewayHost } from "../src/core/registry.js";
import { boundedByteQueue, openStream, streamPolicy } from "../src/core/stream.js";

const route = methodRoute(Fixture.method.watch);
const context = createContext({ caller: "test", trusted: true });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("typed local streams pull only, preserve PB bytes and close simulated SSE reader on break", async () => {
  const host = new GatewayHost();
  let reads = 0;
  let closes = 0;
  host.registerOwner(
    "sse",
    bindStreamHandlers(Fixture, {
      async *watch(request, _client, signal) {
        try {
          while (!signal.aborted) {
            reads++;
            yield create(ChangedSchema, { value: request });
          }
        } finally {
          closes++;
        }
      },
    }),
  );
  const client = bindStreamClient(Fixture, host.client({ caller: "ui", trusted: true }));
  const input = create(EnvelopeSchema, { id: 0xffffffffffffffffn, blobs: [{ data: Uint8Array.of(0, 255) }] });
  const stream = await client.watch(input);
  assert.equal(reads, 0);
  for await (const chunk of stream) {
    assert.deepEqual(chunk.value, input);
    assert.equal(reads, 1);
    await tick();
    assert.equal(reads, 1);
    break;
  }
  assert.equal(closes, 1);
  await stream.cancel();
});

test("abort during open cleans late producer; cancel interrupts pending next independently", async () => {
  let resolve!: (value: AsyncIterableIterator<Uint8Array>) => void;
  let disposed = 0;
  const abort = new AbortController();
  const opening = openStream(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    streamPolicy(),
    { signal: abort.signal },
  );
  await tick();
  abort.abort();
  await assert.rejects(opening, /cancelled/);
  resolve({
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      disposed++;
      return { done: true, value: undefined };
    },
  });
  await tick();
  assert.equal(disposed, 1);
  const stream = await openStream(
    (signal): AsyncIterableIterator<Uint8Array> => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      return: async () => ({ done: true, value: undefined }),
    }),
    streamPolicy(),
  );
  const next = stream.next();
  await tick();
  await assert.rejects(stream.next(), /one pending/);
  const rejected = assert.rejects(next, /cancelled/);
  await stream.cancel();
  await rejected;
  await stream.cancel();
});

test("bounded producer waits at byte/item limits; oversize and unpausable producers fail", async () => {
  const policy = streamPolicy({ queueItems: 1, queueBytes: 2, maxChunkBytes: 2 });
  const controller = new AbortController();
  const queue = boundedByteQueue(policy, controller.signal);
  await queue.send(Uint8Array.of(1, 2));
  let sent = false;
  const sending = queue.send(Uint8Array.of(3)).then(() => {
    sent = true;
  });
  await tick();
  assert.equal(sent, false);
  assert.deepEqual(queue.usage(), { items: 1, bytes: 2 });
  const iterator = queue.source[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, Uint8Array.of(1, 2));
  await sending;
  await assert.rejects(queue.send(new Uint8Array(3)), /too large/);
  await assert.rejects(iterator.next(), /too large/);
  const another = boundedByteQueue(policy, controller.signal);
  await another.send(Uint8Array.of(1));
  const waiting = another.send(Uint8Array.of(2));
  const failure = assert.rejects(waiting, /did not await/);
  await assert.rejects(another.send(Uint8Array.of(3)), /did not await/);
  await failure;
});

test("owner replacement, caller cleanup, quotas and chunk failures release streams", async () => {
  const host = new GatewayHost();
  const registration = {
    route,
    streamPolicy: { maxCallerStreams: 1, maxChunkBytes: 2 },
    streamHandler: async function* () {
      yield new Uint8Array(3);
    },
  };
  host.registerOwner("owner", [registration]);
  const stream = await host.stream(context, route, new Uint8Array());
  await assert.rejects(host.stream(context, route, new Uint8Array()), /admission full/);
  await assert.rejects(stream.next(), /too large/);
  await tick();
  const second = await host.stream(context, route, new Uint8Array());
  host.registerOwner("owner", [registration]);
  await assert.rejects(second.next(), /owner closed/);
  await tick();
  const third = await host.stream(context, route, new Uint8Array());
  host.cleanupCaller("test");
  await assert.rejects(third.next(), /cancelled/);
});

test("separate open, production and consumption clocks; terminal timers are removed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const policy = streamPolicy({ openTimeoutMs: 10, producerIdleMs: 20, consumerIdleMs: 50 });
  const opening = openStream(() => new Promise(() => {}), policy);
  const failed = assert.rejects(opening, /open timed out/);
  t.mock.timers.tick(10);
  await failed;
  const stream = await openStream(async function* () {
    yield Uint8Array.of(1);
  }, policy);
  t.mock.timers.tick(30); // Consumer delay is not producer idle.
  assert.equal((await stream.next()).done, false);
  t.mock.timers.tick(50);
  await assert.rejects(stream.next(), /consumer idle/);
  const pendingStream = await openStream(
    (): AsyncIterableIterator<Uint8Array> => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise(() => {}),
    }),
    policy,
  );
  const pending = assert.rejects(pendingStream.next(), /producer idle/);
  t.mock.timers.tick(20);
  await pending;
});

test("one terminal wins and unfinished producers retain their quota", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const empty = await openStream(async function* () {}, streamPolicy());
  assert.equal((await empty.next()).done, true);
  await empty.cancel();
  assert.equal((await empty.next()).done, true);
  const host = new GatewayHost();
  let complete!: (value: IteratorResult<Uint8Array>) => void;
  host.registerOwner("stuck", [
    {
      route,
      streamPolicy: { maxCallerStreams: 1 },
      streamHandler: () => {
        const source: AsyncIterableIterator<Uint8Array> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
          return: async () => ({ done: true, value: undefined }),
        };
        return source;
      },
    },
  ]);
  const stream = await host.stream(context, route, new Uint8Array());
  const pending = assert.rejects(stream.next(), /cancelled/);
  await Promise.resolve();
  const cancellation = assert.rejects(stream.cancel(), /cleanup timed out/);
  t.mock.timers.tick(1000);
  await cancellation;
  await pending;
  await assert.rejects(host.stream(context, route, new Uint8Array()), /admission full/);
  complete({ done: true, value: undefined });
  await tick();
  const replacement = await host.stream(context, route, new Uint8Array());
  await replacement.cancel();
});

test("an already aborted signal releases execution admission without starting the factory", async () => {
  const { ExecutionScope } = await import("../src/core/execution.js");
  const execution = new ExecutionScope();
  const owner = {};
  let started = 0;
  const registration = {
    route,
    streamPolicy: { maxOwnerStreams: 1, maxCallerStreams: 1 },
    streamHandler: async function* () {
      started++;
      yield new Uint8Array();
    },
  };
  const client = new GatewayHost().client({ caller: "test", trusted: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execution.stream(registration, owner, context, client, new Uint8Array(), { signal: controller.signal }),
    /cancelled/,
  );
  await execution.drained();
  assert.equal(started, 0);
  const stream = await execution.stream(registration, owner, context, client, new Uint8Array());
  await stream.next();
  assert.equal(started, 1);
  await stream.cancel();
  await execution.drained();
});
