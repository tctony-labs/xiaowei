import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { IpcMain, IpcMainInvokeEvent, IpcRenderer, WebContents } from "electron";
import { EnvelopeSchema, Fixture } from "xiaowei-contracts";
import { bindClient, bindHandlers, bindStreamClient, bindStreamHandlers } from "../src/binding/index.js";
import { type ElectronRequest, GATEWAY_CHANNEL } from "../src/core/electron-protocol.js";
import { GatewayHost } from "../src/core/registry.js";
import { attachElectron } from "../src/main/electron.js";
import { createPreloadBridge } from "../src/preload/index.js";
import { createRendererClient } from "../src/renderer/index.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let handler: (event: IpcMainInvokeEvent, message: unknown) => unknown;
  const ipc = {
    handle(_name: string, fn: typeof handler) {
      handler = fn;
    },
    removeHandler() {},
  };
  const host = new GatewayHost();
  const adapter = attachElectron(host, ipc as Pick<IpcMain, "handle" | "removeHandler">);
  let next = 0;
  const frame = (trusted = true) => {
    const renderer = new EventEmitter();
    const contents = Object.assign(new EventEmitter(), {
      id: ++next,
      isDestroyed: () => false,
      mainFrame: {
        send(channel: string, bytes: unknown) {
          renderer.emit(channel, {}, structuredClone(bytes));
        },
      },
    });
    adapter.register(contents as unknown as WebContents, { caller: "unused", trusted });
    const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
    const ipcRenderer = Object.assign(renderer, {
      invoke(channel: string, message: unknown) {
        assert.equal(channel, GATEWAY_CHANNEL);
        return Promise.resolve(handler(event, structuredClone(message))).then((result) => structuredClone(result));
      },
    });
    const bridge = createPreloadBridge(ipcRenderer as unknown as IpcRenderer);
    return { bridge, contents, client: createRendererClient(bridge), ipcRenderer };
  };
  return { host, adapter, frame };
}

test("Electron sessions: bytes, trusted access, restricted access and cross-frame IDs", async () => {
  const { host, frame, adapter } = fixture();
  const owner = host.registerOwner("fixture", bindHandlers(Fixture, { echo: (r) => r }), [
    {
      name: "test.Changed",
      policy: "coalesce",
      validate() {},
      matches() {
        return true;
      },
    },
  ]);
  const a = frame();
  const b = frame();
  const denied = frame(false);
  const input = create(EnvelopeSchema, { id: 0xffffffffffffffffn, blobs: [{ data: Uint8Array.of(0, 255) }] });
  assert.deepEqual(await bindClient(Fixture, a.client).echo(input), input);
  await assert.rejects(bindClient(Fixture, denied.client).echo(input), /authorized/);
  const deliveries: string[] = [];
  const sub = await a.client.subscribe("test.Changed", undefined, () => {
    deliveries.push("a");
  });
  await b.bridge.request({ operation: "unsubscribe", id: "event:1" });
  owner.publish("test.Changed", new Uint8Array());
  await tick();
  assert.deepEqual(deliveries, ["a"]);
  a.contents.emit("did-navigate", {}, "http://localhost/", 200, "OK");
  owner.publish("test.Changed", new Uint8Array());
  await tick();
  assert.deepEqual(deliveries, ["a"]);
  await assert.rejects(bindClient(Fixture, a.client).echo(input), /closed/);
  sub.close();
  adapter.close();
});

test("Electron subscribe ready includes early delivery; late subscribe on navigation is released", async () => {
  const { host, frame, adapter } = fixture();
  let release!: () => void;
  let closed = 0;
  host.registerOwner(
    "source",
    [],
    [
      {
        name: "test.Changed",
        policy: "ordered",
        async attach(_context, _filter, sink) {
          await sink(Uint8Array.of(9));
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return {
            close() {
              closed++;
            },
          };
        },
      },
    ],
  );
  const a = frame();
  const bytes: number[] = [];
  const subscription = a.client.subscribe("test.Changed", undefined, (payload) => {
    bytes.push(payload[0]);
  });
  await tick();
  assert.deepEqual(bytes, [9]);
  a.contents.emit("did-navigate", {}, "http://localhost/", 200, "OK");
  release();
  await assert.rejects(subscription, /closed/);
  assert.equal(closed, 1);
  adapter.close();
});

test("Electron stream next/cancel and navigation during open release producers without crossing objects", async () => {
  const { host, frame, adapter } = fixture();
  let polls = 0;
  let dropped = 0;
  let release!: () => void;
  host.registerOwner(
    "source",
    bindStreamHandlers(Fixture, {
      async watch(request, _client, signal) {
        if (request.text === "open")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        const iterator = {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            polls++;
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            return { done: true as const, value: undefined };
          },
          async return() {
            dropped++;
            return { done: true as const, value: undefined };
          },
        };
        return iterator;
      },
    }),
  );
  const a = frame();
  const b = frame();
  assert.deepEqual(Object.keys(a.bridge), ["request", "listen"]);
  const stream = await bindStreamClient(Fixture, a.client).watch(create(EnvelopeSchema));
  assert.equal(polls, 0);
  const pending = assert.rejects(stream.next(), /cancelled/);
  await tick();
  assert.equal((await b.bridge.request({ operation: "stream.next", id: "stream:1" })).ok, false);
  await stream.cancel();
  await pending;
  await tick();
  assert.equal(dropped, 1);
  const request: ElectronRequest = {
    operation: "stream.open",
    id: "opening",
    route: {
      name: "testing.Fixture.Watch",
      kind: "serverStreaming",
      input: "testing.Envelope",
      output: "testing.Changed",
      controlVersion: 1,
      contractVersion: 1,
    },
    payload: Uint8Array.of(10, 4, 111, 112, 101, 110),
  };
  const opening = a.bridge.request(request);
  await tick();
  a.contents.emit("did-navigate", {}, "http://localhost/", 200, "OK");
  assert.equal((await opening).ok, false);
  release();
  await tick();
  adapter.close();
});

test("Electron pending subscription cancellation retains bounded admission until attach settles", async () => {
  const { host, frame, adapter } = fixture();
  const releases: Array<() => void> = [];
  let closed = 0;
  host.registerOwner(
    "source",
    [],
    [
      {
        name: "test.Pending",
        policy: "ordered",
        async attach() {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          return {
            close() {
              closed++;
            },
          };
        },
      },
    ],
  );
  const a = frame();
  const pending = [];
  for (let i = 0; i < 128; i++) {
    const id = String(i);
    pending.push(a.bridge.request({ operation: "subscribe", event: "test.Pending", id }));
    await tick();
    await a.bridge.request({ operation: "unsubscribe", id });
  }
  const full = await a.bridge.request({ operation: "subscribe", event: "test.Pending", id: "overflow" });
  assert.equal(full.ok, false);
  if (!full.ok) assert.equal(full.error.code, "RESOURCE_EXHAUSTED");
  for (const release of releases) release();
  await Promise.all(pending);
  assert.equal(closed, 128);
  adapter.close();
});

test("cancelled navigation keeps the document session; committed reload replaces it", async () => {
  const { host, frame, adapter } = fixture();
  const owner = host.registerOwner("fixture", bindHandlers(Fixture, { echo: (request) => request }), [
    {
      name: "test.Changed",
      policy: "coalesce",
      validate() {},
      matches: () => true,
    },
  ]);
  const a = frame();
  const input = create(EnvelopeSchema, { text: "still connected" });
  let deliveries = 0;
  await a.client.subscribe("test.Changed", undefined, () => {
    deliveries++;
  });

  // will-navigate can prevent the attempt, so did-navigate never follows.
  a.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(await bindClient(Fixture, a.client).echo(input), input);
  owner.publish("test.Changed", new Uint8Array());
  await tick();
  assert.equal(deliveries, 1);

  a.contents.emit("did-navigate", {}, "http://localhost/", 200, "OK");
  await assert.rejects(bindClient(Fixture, a.client).echo(input), /closed/);
  owner.publish("test.Changed", new Uint8Array());
  await tick();
  assert.equal(deliveries, 1);

  const bridge = createPreloadBridge(a.ipcRenderer as unknown as IpcRenderer);
  const client = createRendererClient(bridge);
  assert.deepEqual(await bindClient(Fixture, client).echo(input), input);
  const subscription = await client.subscribe("test.Changed", undefined, () => {
    deliveries++;
  });
  owner.publish("test.Changed", new Uint8Array());
  await tick();
  assert.equal(deliveries, 2);
  await assert.rejects(bindClient(Fixture, a.client).echo(input), /closed/);
  subscription.close();
  adapter.close();
});
