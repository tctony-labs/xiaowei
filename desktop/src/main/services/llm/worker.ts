import { parentPort, workerData } from "node:worker_threads";
import { exposeWorkerEndpoint } from "xiaowei-gateway/worker";
import { llmRegistrations } from "./gateway";

if (!parentPort) throw new Error("LLM service requires a worker parent port");
exposeWorkerEndpoint(parentPort, llmRegistrations(workerData.models));
