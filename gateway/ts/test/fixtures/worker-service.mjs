import { parentPort, threadId, workerData } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import { ChangedSchema, EnvelopeSchema, Fixture, PeerFixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, bindStreamClient, bindStreamHandlers } from "../../src/binding/index.ts";
import { GatewayFailure } from "../../src/core/protocol.ts";
import { exposeWorkerEndpoint } from "../../src/worker/endpoint.ts";

const control = workerData?.control;
const clock = workerData?.fakeTimers ? (await import("node:test")).mock.timers : undefined;
clock?.enable({ apis: ["setTimeout"] });
parentPort.on("message", (frame) => {
  if (frame.kind === "accepted") control?.postMessage("budget");
});
const gates = new Map();
const note = (event) => control?.postMessage(event);
const gate = (name) =>
  new Promise((resolve) => {
    const list = gates.get(name) ?? [];
    list.push(resolve);
    gates.set(name, list);
    note(name);
  });
control?.on("message", (name) => {
  if (typeof name === "object" && typeof name.tick === "number") {
    clock.tick(name.tick);
    note("advanced");
    return;
  }
  for (const resolve of gates.get(name) ?? []) resolve();
  gates.delete(name);
});
const service = workerData?.peer ? PeerFixture : Fixture;
const peer = workerData?.peer ? Fixture : PeerFixture;
let child;
const handlers = bindHandlers(service, {
  async echo(request, client) {
    if (request.text === "wait") await gate("unary");
    if (request.text === "thread") return create(EnvelopeSchema, { id: BigInt(threadId) });
    if (request.text === "block") {
      note("blocking");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
    }
    if (request.text === "relay") return bindClient(peer, client).echo(request);
    if (request.text === "child-open") {
      child = await bindStreamClient(peer, client).watch(request);
      return request;
    }
    if (request.text === "child-next") {
      const item = await child.next();
      return item.value?.value ?? request;
    }
    if (request.text === "child-close") await child.cancel();
    if (request.text === "subscribe") await client.subscribe("testing.Event", undefined, () => {});
    return request;
  },
}).map((r) => ({ ...r, timeoutMs: workerData?.timeoutMs ?? 100, maxConcurrency: workerData?.concurrency ?? 2 }));
const streams = bindStreamHandlers(service, {
  async watch(request, client, signal) {
    if (request.text === "relay") return bindStreamClient(peer, client).watch(request, { signal });
    if (request.text === "openwait") await gate("opening");
    if (request.text === "openfail") throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "open failed" });
    note("opened");
    let index = 0;
    signal.addEventListener("abort", () => note("aborted"), { once: true });
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        note("next");
        if (request.text === "nextwait") await gate("producing");
        if (request.text === "wait") {
          note("waiting");
          await new Promise((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", resolve, { once: true });
          });
        }
        if (request.text === "exit") process.exit(7);
        if (request.text === "fail" && index === 1)
          throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "stream failed" });
        if (index >= Number(request.id)) return { done: true };
        return { done: false, value: create(ChangedSchema, { value: { ...request, id: BigInt(index++) } }) };
      },
      async return() {
        if (request.text === "returnwait") await gate("returning");
        note("returned");
        note(`${request.text}:returned`);
        return { done: true };
      },
    };
  },
}).map((r) => ({
  ...r,
  streamPolicy: {
    maxOwnerStreams: workerData?.maxStreams ?? 4,
    maxCallerStreams: workerData?.maxStreams ?? 4,
    maxChunkBytes: workerData?.maxChunkBytes ?? 1024 * 1024,
    producerIdleMs: workerData?.producerIdleMs ?? 5000,
    consumerIdleMs: workerData?.consumerIdleMs ?? 5000,
    openTimeoutMs: workerData?.openTimeoutMs ?? 5000,
  },
}));
exposeWorkerEndpoint(parentPort, [...handlers, ...streams]);
