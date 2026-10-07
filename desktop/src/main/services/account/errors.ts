import { ErrorCode } from "xiaowei-contracts";

export class AccountError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function accountError(error: unknown): AccountError {
  return error instanceof AccountError ? error : new AccountError(ErrorCode.INTERNAL_ERROR, "账号操作失败，请重试");
}
