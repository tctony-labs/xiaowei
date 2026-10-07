import { type DescMessage, fromJson, type JsonValue, type MessageShape } from "@bufbuild/protobuf";
import { ErrorCode } from "xiaowei-contracts";

type Outcome =
  | "success"
  | "business_error"
  | "http_error"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "protocol_error"
  | "response_too_large";

export class HttpRequestError extends Error {
  constructor(
    public readonly outcome: Exclude<Outcome, "success">,
    message = "",
    public readonly httpStatus?: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method: "GET" | "POST";
  // A code-defined route template, never a URL or user-supplied pathname.
  logPath: string;
  signal: AbortSignal;
  timeoutMs: number;
  body?: string;
  token?: string;
}

export class ServerHttpClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async request<S extends DescMessage>(
    url: string,
    schema: S,
    options: RequestOptions,
    decode: (value: JsonValue) => MessageShape<S> = (value) => fromJson(schema, value),
  ): Promise<MessageShape<S>> {
    const start = performance.now();
    const timeout = options.timeoutMs === 0 ? undefined : AbortSignal.timeout(options.timeoutMs);
    let httpStatus: number | undefined;
    let code: number | undefined;
    let outcome: Outcome = "success";
    let origin: string | undefined;

    try {
      origin = new URL(url).origin;
    } catch {
      // The actual request reports invalid URLs; never echo the submitted value.
    }
    const requestMetadata = {
      method: options.method,
      path: options.logPath,
      timeout_ms: options.timeoutMs,
      ...(origin === undefined ? {} : { server: origin }),
    };
    console.debug(formatRequestLog("HTTP request started", requestMetadata));

    try {
      let contents: string;
      try {
        const response = await this.fetcher(url, {
          method: options.method,
          headers: {
            "Content-Type": "application/json",
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: options.body,
          redirect: "error",
          signal: timeout ? AbortSignal.any([options.signal, timeout]) : options.signal,
        });
        httpStatus = response.status;
        if (httpStatus !== 200) throw new HttpRequestError("http_error", "", httpStatus);
        contents = await response.text();
        if (Buffer.byteLength(contents) > 65_536) throw new HttpRequestError("response_too_large", "", httpStatus);
      } catch (error) {
        if (error instanceof HttpRequestError) throw error;
        const category = options.signal.aborted ? "cancelled" : timeout?.aborted ? "timeout" : "network_error";
        throw new HttpRequestError(category, "", httpStatus);
      }

      try {
        const envelope = JSON.parse(contents);
        if (
          !Number.isInteger(envelope?.code) ||
          envelope.code < -2_147_483_648 ||
          envelope.code > 2_147_483_647 ||
          typeof envelope.msg !== "string"
        ) {
          throw new Error("Invalid envelope");
        }
        code = envelope.code;
        if (code !== 0) {
          throw new HttpRequestError("business_error", envelope.msg || "服务器拒绝了此操作", httpStatus, code);
        }
        if (!envelope.data) throw new Error("Missing data");
        return decode(envelope);
      } catch (error) {
        if (error instanceof HttpRequestError) throw error;
        throw new HttpRequestError("protocol_error", "", httpStatus, code);
      }
    } catch (error) {
      const failure = error instanceof HttpRequestError ? error : new HttpRequestError("network_error");
      outcome = failure.outcome;
      throw failure;
    } finally {
      // Build from metadata only. Bodies, headers, messages and exceptions never enter the logger.
      const metadata = {
        ...requestMetadata,
        duration_ms: Math.round(performance.now() - start),
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
        ...(code === undefined ? {} : { code }),
      };
      if (outcome === "success" || outcome === "cancelled") {
        console.debug(formatRequestLog("HTTP request completed", metadata));
      } else if (outcome === "business_error" && code !== ErrorCode.INTERNAL_ERROR && code !== ErrorCode.UNAVAILABLE) {
        console.warn(formatRequestLog("HTTP request completed", metadata));
      } else if (outcome === "http_error" && httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
        console.warn(formatRequestLog("HTTP request completed", metadata));
      } else {
        console.error(formatRequestLog("HTTP request completed", metadata));
      }
    }
  }
}

function formatRequestLog(message: string, metadata: Record<string, string | number>) {
  const fields = Object.entries(metadata).map(([key, value]) => {
    const text = typeof value === "string" && /[\s"=\\]/u.test(value) ? JSON.stringify(value) : String(value);
    return `${key}=${text}`;
  });
  return `${message} ${fields.join(" ")}`;
}
