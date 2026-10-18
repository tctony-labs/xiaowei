import { type GatewayError, GatewayFailure, type Manifest, type Route } from "../core/protocol.js";
import type { StreamPolicy } from "../core/stream.js";

export const MAX_PAYLOAD = 8 * 1024 * 1024;
export const MAX_METADATA = 64 * 1024;
export const MAX_OPTIONS = 64 * 1024;
export const LIMIT = 128;
export interface Header {
  v: 1;
  generation: string;
  op: string;
  id?: string;
  target?: string;
  route?: Route;
  event?: string;
  error?: GatewayError;
  manifest?: Manifest;
  token?: string;
  policy?: StreamPolicy;
  done?: boolean;
  seq?: number;
  optionsBytes?: number;
}
export interface Frame {
  header: Header;
  payload: Uint8Array;
  options?: Uint8Array;
}
export const unavailable = () =>
  new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "WebSocket connection unavailable" });
export function encode(
  header: Header,
  payload: Uint8Array = new Uint8Array(),
  options?: Uint8Array,
) {
  if (payload.byteLength > MAX_PAYLOAD || (options?.byteLength ?? 0) > MAX_OPTIONS)
    throw new GatewayFailure({
      code: "RESOURCE_EXHAUSTED",
      message: "WebSocket payload too large",
    });
  const metadata = new TextEncoder().encode(
    JSON.stringify({ ...header, optionsBytes: options?.length ?? 0 }),
  );
  if (metadata.length > MAX_METADATA)
    throw new GatewayFailure({
      code: "RESOURCE_EXHAUSTED",
      message: "WebSocket metadata too large",
    });
  const bytes = new Uint8Array(4 + metadata.length + payload.length + (options?.length ?? 0));
  new DataView(bytes.buffer).setUint32(0, metadata.length);
  bytes.set(metadata, 4);
  bytes.set(payload, 4 + metadata.length);
  if (options) bytes.set(options, 4 + metadata.length + payload.length);
  return bytes;
}
export function decode(data: unknown): Frame {
  if (
    !(data instanceof ArrayBuffer) ||
    data.byteLength < 4 ||
    data.byteLength > 4 + MAX_METADATA + MAX_PAYLOAD + MAX_OPTIONS
  )
    throw unavailable();
  const bytes = new Uint8Array(data);
  const size = new DataView(data).getUint32(0);
  if (size > MAX_METADATA || size + 4 > bytes.length) throw unavailable();
  const header = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + size)),
  ) as Header;
  if (
    header?.v !== 1 ||
    typeof header.generation !== "string" ||
    header.generation.length > 100 ||
    typeof header.op !== "string" ||
    !Number.isSafeInteger(header.optionsBytes) ||
    (header.optionsBytes ?? -1) < 0 ||
    (header.optionsBytes ?? 0) > MAX_OPTIONS ||
    (header.id !== undefined && (typeof header.id !== "string" || header.id.length > 100)) ||
    (header.target !== undefined &&
      (typeof header.target !== "string" || header.target.length > 100))
  )
    throw unavailable();
  const end = bytes.length - (header.optionsBytes ?? 0);
  if (end < size + 4 || end - size - 4 > MAX_PAYLOAD) throw unavailable();
  return {
    header,
    payload: bytes.subarray(4 + size, end),
    options: header.optionsBytes ? bytes.subarray(end) : undefined,
  };
}
