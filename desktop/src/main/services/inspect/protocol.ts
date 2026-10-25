export const INSPECT_PROTOCOL = "xiaowei-inspect";
export const INSPECT_VERSION = 1;
export const INSPECT_MAX_BYTES = 1024 * 1024;
export const INSPECT_TIMEOUT_MS = 5000;

export interface InspectSource {
  kind: "workspace" | "app";
  path: string;
}

export interface InspectRequest {
  protocol: string;
  version: number;
  id: string;
  source: InspectSource;
  method: string;
  params: Record<string, unknown>;
}

export interface InspectResponse {
  protocol: string;
  version: number;
  id: string;
  source: InspectSource;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface InspectParameter {
  type: "string" | "boolean";
  required?: boolean;
  values?: readonly string[];
}

export interface InspectMethod {
  description: string;
  mutates: boolean;
  params: Record<string, InspectParameter>;
  run(params: Record<string, unknown>): unknown | Promise<unknown>;
}

export class InspectError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
