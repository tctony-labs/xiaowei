import { parentPort, workerData } from "node:worker_threads";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { initializeWorkerLogging } from "@xiaowei/source-log/worker";
import { exposeWorkerEndpoint } from "xiaowei-gateway/worker";
import type { ResolvedModelConfig } from "../shared/models";
import { llmRegistrations } from "./gateway";

if (!parentPort) throw new Error("LLM service requires a worker parent port");
initializeWorkerLogging();
const models: readonly ResolvedModelConfig[] = workerData.models;
exposeWorkerEndpoint(parentPort, llmRegistrations(models));

const providerCount = new Set(models.map((model) => model.provider)).size;
console.info("LLM worker ready: loaded %d models from %d providers", models.length, providerCount);

parentPort.once("close", () => cleanupSessionResources());
