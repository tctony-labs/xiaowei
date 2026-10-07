import { ErrorCode } from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";

export class AccountError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function accountError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  if (error instanceof GatewayFailure) {
    if (error.detail.code === "UNAUTHORIZED") return new AccountError(ErrorCode.PERMISSION_DENIED, "账号调用权限不足");
    if (error.detail.code === "INVALID_ARGUMENT")
      return new AccountError(ErrorCode.INVALID_ARGUMENT, "账号请求参数无效");
    return new AccountError(
      ErrorCode.UNAVAILABLE,
      error.detail.code === "CANCELLED" ? "账号操作已取消" : "账号服务暂不可用，请稍后重试",
    );
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AccountError(ErrorCode.UNAVAILABLE, "账号操作已取消");
  }
  return new AccountError(ErrorCode.INTERNAL_ERROR, "账号操作失败，请重试");
}
