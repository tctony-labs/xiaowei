import { MessageChannel, Worker } from "node:worker_threads";
import { GatewayHost } from "../../src/core/registry.js";
import { attachWorker } from "../../src/main/worker.js";

export async function workerFixture(options: Record<string, unknown> = {}, host = new GatewayHost(), name = "worker") {
  const channel = new MessageChannel();
  const events: string[] = [];
  const waiters = new Map<string, (() => void)[]>();
  channel.port1.on("message", (event: string) => {
    const waiter = waiters.get(event)?.shift();
    if (waiter) waiter();
    else events.push(event);
  });
  const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    execArgv: [],
    workerData: { ...options, control: channel.port2 },
    transferList: [channel.port2],
  });
  const handle = await attachWorker(host, name, worker);
  return {
    host,
    worker,
    handle,
    wait(event: string): Promise<void> {
      const index = events.indexOf(event);
      if (index !== -1) {
        events.splice(index, 1);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const list = waiters.get(event) ?? [];
        list.push(resolve);
        waiters.set(event, list);
      });
    },
    advance(ms: number) {
      channel.port1.postMessage({ tick: ms });
    },
    release(event: string) {
      channel.port1.postMessage(event);
    },
    async close() {
      channel.port1.close();
      await handle.close();
    },
  };
}
