import { invalid } from "./protocol.js";

const ABSENT = 0xffff_ffff;
const MAX_OPTIONS_BYTES = 65_536;

/** Unary napi uses one Buffer; options and business bytes remain separately encoded. */
export function encodeInvokeFrame(payload: Uint8Array, options?: Uint8Array): Uint8Array {
  if (options !== undefined && options.byteLength > MAX_OPTIONS_BYTES) invalid("service options too large");
  const frame = new Uint8Array(4 + (options?.byteLength ?? 0) + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, options?.byteLength ?? ABSENT, true);
  if (options) frame.set(options, 4);
  frame.set(payload, 4 + (options?.byteLength ?? 0));
  return frame;
}

export function decodeInvokeFrame(frame: Uint8Array): { payload: Uint8Array; serviceOptions?: Uint8Array } {
  if (frame.byteLength < 4) invalid("invalid unary frame");
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  if (length === ABSENT) return { payload: frame.subarray(4) };
  if (length > MAX_OPTIONS_BYTES || length > frame.byteLength - 4) invalid("invalid service options frame");
  return { payload: frame.subarray(4 + length), serviceOptions: frame.subarray(4, 4 + length) };
}
