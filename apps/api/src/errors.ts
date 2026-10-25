import { ERROR_STATUS, type ErrorCode } from "@gachipad/shared";

/** Thrown by handlers; the error handler turns it into `{error: {code, message}}` (§9). */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export const notFound = (what = "Not found") => new ApiError("not_found", what);
export const forbidden = (message = "Forbidden") => new ApiError("forbidden", message);
export const invalid = (message: string) => new ApiError("validation", message);
export const tooLarge = (message: string) => new ApiError("too_large", message);
