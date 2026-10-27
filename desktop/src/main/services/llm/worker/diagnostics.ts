import { GatewayFailure } from "xiaowei-gateway";
import type { ResolvedModelConfig } from "../shared/models";

// Provider messages can contain response bodies, prompts and credentials. Emit only
// recognized local loader details, HTTP status and fixed failure categories.
export function generationDiagnostic(
  error: unknown,
  api: ResolvedModelConfig["api"],
  httpStatus?: number,
) {
  if (httpStatus !== undefined && httpStatus >= 400)
    return { cause: "http_error", status: httpStatus };

  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const module = message.match(/^Cannot find module ['"][^'"\n]*\/chunks\/([^/'"\n]+)['"]/);
  if (module?.[1].startsWith(`${api}-`) && /^[a-zA-Z0-9_-]+\.js$/.test(module[1]))
    return { cause: "provider_module_missing", module: module[1] };

  if (error instanceof GatewayFailure) return { cause: "gateway_error", code: error.detail.code };

  const networkCode = message.match(
    /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/,
  );
  if (networkCode) return { cause: "network_error", code: networkCode[1] };

  return { cause: "provider_error", status: httpStatus };
}
