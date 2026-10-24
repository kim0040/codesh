import { z } from "./zod.js";

export const ERROR_CODES = [
  "not_found",
  "forbidden",
  "pin_required",
  "pin_invalid",
  "banned",
  "pending_approval",
  "rate_limited",
  "too_large",
  "expired",
  "validation",
  "unavailable",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** HTTP status for each stable error code (§9). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  pin_required: 401,
  pin_invalid: 403,
  banned: 403,
  pending_approval: 403,
  rate_limited: 429,
  too_large: 413,
  expired: 410,
  validation: 400,
  unavailable: 503,
};

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function errorResponse(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}
