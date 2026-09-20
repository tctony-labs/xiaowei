import { GatewayFailure } from "./protocol.js";

export interface Permissions {
  caller: string;
  trusted: boolean;
  invoke?: readonly string[];
  subscribe?: readonly string[];
}
// WeakMap membership makes a deserialized/spread caller object unusable as a context.
const contexts = new WeakMap<object, Permissions>();
declare const contextBrand: unique symbol;
export interface CallContext {
  readonly [contextBrand]: true;
}
export function createContext(permissions: Permissions): CallContext {
  const context = Object.freeze({}) as CallContext;
  contexts.set(
    context,
    Object.freeze({
      ...permissions,
      invoke: Object.freeze([...(permissions.invoke ?? [])]),
      subscribe: Object.freeze([...(permissions.subscribe ?? [])]),
    }),
  );
  return context;
}
export function authorize(context: CallContext, name: string, event = false): void {
  const permissions = contexts.get(context);
  if (!permissions || (!permissions.trusted && !(event ? permissions.subscribe : permissions.invoke)?.includes(name))) {
    throw new GatewayFailure({ code: "UNAUTHORIZED", message: "capability not authorized" });
  }
}
export function caller(context: CallContext): string {
  const permissions = contexts.get(context);
  if (!permissions) throw new GatewayFailure({ code: "UNAUTHORIZED", message: "invalid host context" });
  return permissions.caller;
}
