export const CONTROL_VERSION = 1;
export const CONTRACT_VERSION = 1;

export type ErrorCode =
  | "CANCELLED"
  | "RESOURCE_EXHAUSTED"
  | "UNKNOWN_ROUTE"
  | "OWNER_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "CONCURRENCY_FULL"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "HANDLER_ERROR"
  | "CONFLICT"
  | "INCOMPATIBLE"
  | "WRONG_METHOD_KIND";
export interface GatewayError {
  code: ErrorCode;
  message: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: GatewayError };
export const failure = (code: ErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
export const success = <T>(value: T): Result<T> => ({ ok: true, value });

// Exceptions are local convenience only; transport always sends the plain Result union.
export class GatewayFailure extends Error {
  constructor(readonly detail: GatewayError) {
    super(detail.message);
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new GatewayFailure(result.error);
  return result.value;
}
export function invalid(message: string): never {
  throw new GatewayFailure({ code: "INVALID_ARGUMENT", message });
}
export function validateName(name: string): void {
  if (!name || new TextEncoder().encode(name).length > 200 || name.split(".").some((part) => !part)) {
    invalid("invalid gateway name");
  }
}
export interface Route {
  readonly name: string;
  readonly kind: "unary" | "serverStreaming";
  readonly controlVersion: number;
  readonly contractVersion: number;
  readonly input: string;
  readonly output: string;
}
export function validateRoute(route: Route): void {
  validateName(route.name);
  validateName(route.input);
  validateName(route.output);
  if (route.controlVersion !== CONTROL_VERSION || route.contractVersion !== CONTRACT_VERSION) {
    throw new GatewayFailure({ code: "INCOMPATIBLE", message: "unsupported protocol or contract version" });
  }
  if (route.kind !== "unary" && route.kind !== "serverStreaming") invalid("invalid method kind");
}
export function accepts(actual: Route, request: Route): Result<void> {
  if (
    actual.name !== request.name ||
    actual.kind !== request.kind ||
    actual.input !== request.input ||
    actual.output !== request.output ||
    actual.controlVersion !== request.controlVersion ||
    actual.contractVersion !== request.contractVersion
  )
    return failure("INCOMPATIBLE", "route contract mismatch");
  if (actual.kind !== "unary") return failure("WRONG_METHOD_KIND", "stream execution requires stream API");
  return success(undefined);
}
export type Backpressure = "ordered" | "coalesce" | "drop";
export interface EventDescriptor {
  readonly name: string;
  readonly policy: Backpressure;
}
export interface RegisteredRoute extends Route {
  readonly streamPolicy?: Partial<import("./stream.js").StreamPolicy>;
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
}
export interface Manifest {
  readonly routes: readonly RegisteredRoute[];
  readonly events: readonly EventDescriptor[];
}
export interface Subscription {
  close(): void;
}
export interface Transport {
  stream?(
    route: Route,
    payload: Uint8Array,
    options?: import("./stream.js").StreamOptions,
  ): Promise<import("./stream.js").ResponseStream<Uint8Array>>;
  invoke(route: Route, payload: Uint8Array): Promise<Result<Uint8Array>>;
  subscribe(
    event: string,
    filter: Uint8Array | undefined,
    sink: EventSink,
    persistent?: boolean,
  ): Promise<Subscription>;
}
export type EventSink = (payload: Uint8Array) => void | Promise<void>;
