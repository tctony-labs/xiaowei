import { createConnection } from "node:net";
import { INSPECT_PROTOCOL, INSPECT_VERSION } from "../src/main/services/inspect/protocol.ts";

export function rawRequest(path, frame) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error("Fixture request timed out")));
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      socket.destroy();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function callInspect(server, method, params = {}, changes = {}) {
  const request = {
    protocol: INSPECT_PROTOCOL,
    version: INSPECT_VERSION,
    id: "fixture",
    source: server.source,
    method,
    params,
    ...changes,
  };
  const response = await rawRequest(server.path, `${JSON.stringify(request)}\n`);
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code });
  }
  return response.result;
}
