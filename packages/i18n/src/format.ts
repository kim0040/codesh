import { type Locale, t } from "./translate.js";

export { formatNumber } from "./translate.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 minutes ago" / "3분 전" / "in 2 days". `deltaMs` is target minus now, so negative means past.
 * Under a minute reads "just now" instead of counting seconds.
 */
export function formatRelativeTime(locale: Locale, deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < MINUTE) return t(locale, "time.justNow");
  const sign = deltaMs < 0 ? -1 : 1;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < HOUR) return format.format(sign * Math.floor(abs / MINUTE), "minute");
  if (abs < DAY) return format.format(sign * Math.floor(abs / HOUR), "hour");
  const days = Math.floor(abs / DAY);
  if (days < 30) return format.format(sign * days, "day");
  if (days < 365) return format.format(sign * Math.min(11, Math.floor(days / 30)), "month");
  return format.format(sign * Math.floor(days / 365), "year");
}

export type DurationStyle = "long" | "short" | "narrow";

const DURATION_UNITS = [
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", SECOND],
] as const;

/**
 * "1 hr 30 min" / "1시간 30분". Shows the largest unit and the one right below it when non-zero,
 * so "2 days 5 hr" never grows into a four-part string.
 */
export function formatDuration(locale: Locale, ms: number, style: DurationStyle = "short"): string {
  let rest = Math.round(Math.max(0, ms) / SECOND) * SECOND;
  const amounts = DURATION_UNITS.map(([unit, size]) => {
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    return { unit, amount };
  });
  const first = amounts.findIndex((part) => part.amount > 0);
  const start = first === -1 ? amounts.length - 1 : first;
  return amounts
    .slice(start, start + 2)
    .filter((part, index) => index === 0 || part.amount > 0)
    .map(({ unit, amount }) =>
      new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: style }).format(amount),
    )
    .join(" ");
}
