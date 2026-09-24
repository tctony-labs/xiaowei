import { Worker } from "node:worker_threads";
import type { GatewayHost } from "xiaowei-gateway/host";
import { attachWorker } from "xiaowei-gateway/worker-host";
import type { ModelConfig } from "./provider";

export function attachLlm(host: GatewayHost, models: readonly ModelConfig[]) {
  const worker = new Worker(new URL("./llm-worker.js", import.meta.url), { workerData: { models } });
  return attachWorker(host, "llm", worker);
}
