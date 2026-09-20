import { createClient } from "../core/client.js";
import type { GatewayBridge } from "../core/electron-protocol.js";
import { type Transport, unwrap } from "../core/protocol.js";
import { decodeFrame, openStream, streamPolicy } from "../core/stream.js";

export type { GatewayBridge } from "../core/electron-protocol.js";

export function createRendererClient(bridge: GatewayBridge) {
  let nextId = 0;
  const transport: Transport = {
    invoke: (route, payload) => bridge.request({ operation: "invoke", route, payload }),
    async subscribe(event, filter, sink, persistent = false) {
      const id = `event:${++nextId}`;
      const unlisten = bridge.listen((received, payload) => {
        if (received === id)
          void Promise.resolve(sink(payload)).catch((error) => console.error("Gateway event failed", error));
      });
      try {
        unwrap(await bridge.request({ operation: "subscribe", id, event, filter, persistent }));
      } catch (error) {
        unlisten();
        void bridge.request({ operation: "unsubscribe", id });
        throw error;
      }
      return {
        close() {
          unlisten();
          void bridge
            .request({ operation: "unsubscribe", id })
            .then(unwrap)
            .catch((error) => console.error("Gateway unsubscribe failed", error));
        },
      };
    },
    async stream(route, payload, options) {
      const id = `stream:${++nextId}`;
      let sequence = 0;
      const policy = streamPolicy();
      return openStream(
        async (signal) => {
          let cancellation: Promise<void> | undefined;
          const cancel = () => {
            cancellation ??= bridge.request({ operation: "stream.cancel", id }).then((result) => {
              unwrap(result);
            });
            void cancellation.catch(() => {});
            return cancellation;
          };
          signal.addEventListener("abort", cancel, { once: true });
          const opening = bridge.request({ operation: "stream.open", id, route, payload });
          if (signal.aborted) void cancel();
          try {
            const bytes = unwrap(await opening);
            Object.assign(policy, streamPolicy(JSON.parse(new TextDecoder().decode(bytes))));
          } catch (error) {
            await cancel();
            throw error;
          }
          const source: AsyncIterableIterator<Uint8Array> = {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              const bytes = unwrap(await bridge.request({ operation: "stream.next", id }));
              return decodeFrame(bytes, sequence++);
            },
            async return() {
              signal.removeEventListener("abort", cancel);
              await cancel();
              return { done: true, value: undefined };
            },
          };
          return source;
        },
        policy,
        options,
      );
    },
  };
  return createClient(transport);
}
