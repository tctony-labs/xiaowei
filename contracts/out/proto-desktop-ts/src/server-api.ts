import { type DescMethod, getOption } from "@bufbuild/protobuf";
import { api } from "./gen/xiaowei/server/common_pb.ts";

/** Network addressing is derived only at the server API boundary, never in the local Gateway. */
export function serverApiMethod(method: DescMethod) {
  if (method.methodKind !== "unary") throw new Error("Server API requires unary methods");
  const prefix = "xiaowei.server.";
  const service = method.parent.typeName;
  if (!service.startsWith(prefix) || service.length === prefix.length) {
    throw new Error("Server API method has an invalid namespace");
  }
  const id = `${service.slice(prefix.length)}/${method.name}`;
  const requiresLogin = !getOption(method, api).noLogin;
  return { id, path: `/api/${id}`, requiresLogin, websocket: requiresLogin };
}
