import { parentPort, workerData } from "node:worker_threads";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { exposeWorkerEndpoint } from "xiaowei-gateway/worker";
import { llmRegistrations } from "./gateway";

if (!parentPort) throw new Error("LLM service requires a worker parent port");
exposeWorkerEndpoint(parentPort, llmRegistrations(workerData.models));

parentPort.once("close", () => cleanupSessionResources());
