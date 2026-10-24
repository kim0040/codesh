/** Default auto-dismiss time of a toast, in milliseconds. */
export const DEFAULT_TOAST_DURATION = 5000;

/**
 * How long a toast stays: an explicit `duration` wins; otherwise errors and toasts with an action
 * stay until dismissed (`Infinity`, which Radix treats as "never"), and everything else uses the
 * default. A message the person must read or answer should not vanish on a timer.
 */
export function toastDuration(options: {
  duration?: number;
  tone?: string;
  action?: unknown;
}): number {
  if (options.duration !== undefined) return options.duration;
  if (options.tone === "danger" || options.action) return Number.POSITIVE_INFINITY;
  return DEFAULT_TOAST_DURATION;
}
