import type { MessageKey } from "@codesh/i18n";
import { type ClientErrorCode, isApiError } from "./api";

interface ErrorText {
  title: MessageKey;
  hint?: MessageKey;
}

const TEXT: Record<ClientErrorCode, ErrorText> = {
  not_found: { title: "error.not_found", hint: "error.not_found.hint" },
  forbidden: { title: "error.forbidden", hint: "error.forbidden.hint" },
  pin_required: { title: "error.pin_required", hint: "error.pin_required.hint" },
  pin_invalid: { title: "error.pin_invalid", hint: "error.pin_invalid.hint" },
  banned: { title: "error.banned", hint: "error.banned.hint" },
  pending_approval: { title: "error.pending_approval", hint: "error.pending_approval.hint" },
  rate_limited: { title: "error.rate_limited", hint: "error.rate_limited.hint" },
  too_large: { title: "error.too_large", hint: "error.too_large.hint" },
  expired: { title: "error.expired", hint: "error.expired.hint" },
  validation: { title: "error.validation", hint: "error.validation.hint" },
  network: { title: "error.network", hint: "error.network.hint" },
  unknown: { title: "error.generic" },
};

/** Message keys for an error from the API client (or anything thrown, as "generic"). */
export function errorText(error: unknown): ErrorText {
  return isApiError(error) ? TEXT[error.code] : TEXT.unknown;
}
