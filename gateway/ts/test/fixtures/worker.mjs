import { parentPort, workerData } from "node:worker_threads";

if (workerData?.built) {
  const { exposeWorkerEndpoint } = await import("xiaowei-gateway/worker");
  const route = {
    name: "testing.Fixture.Echo",
    kind: "unary",
    input: "testing.Envelope",
    output: "testing.Envelope",
    controlVersion: 1,
    contractVersion: 1,
  };
  exposeWorkerEndpoint(parentPort, [
    { route, handler: (bytes) => bytes },
    {
      route: { ...route, name: "testing.Fixture.Watch", kind: "serverStreaming" },
      streamHandler: async function* (bytes) {
        yield bytes;
      },
    },
  ]);
} else {
  const { tsImport } = await import("tsx/esm/api");
  await tsImport("./worker-service.mjs", import.meta.url);
}
