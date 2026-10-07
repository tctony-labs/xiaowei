import { ErrorCode } from "xiaowei-contracts";
import { XwapiError } from "../xwapi/service";

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
  if (error instanceof XwapiError) return new AccountError(error.code, error.message);
  return new AccountError(ErrorCode.INTERNAL_ERROR, "账号操作失败，请重试");
}
