import { Progress as ProgressPrimitive } from "radix-ui";
import { cx } from "../lib/cx.js";

export interface ProgressBarProps {
  /** 0–100, or `null` while the amount is unknown. */
  value: number | null;
  /** Required: what is progressing ("Uploading project.zip"). */
  "aria-label": string;
  /** Show the percentage to the right (tabular digits). */
  showValue?: boolean;
  tone?: "accent" | "success" | "danger";
  size?: "sm" | "md";
  className?: string;
}

const fill = { accent: "bg-accent", success: "bg-success", danger: "bg-danger" } as const;

/** Determinate when `value` is a number, indeterminate (sweeping) when `null`. */
export function ProgressBar({
  value,
  "aria-label": ariaLabel,
  showValue = false,
  tone = "accent",
  size = "md",
  className,
}: ProgressBarProps) {
  const clamped = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <ProgressPrimitive.Root
        aria-label={ariaLabel}
        value={clamped}
        max={100}
        className={cx(
          "relative w-full overflow-hidden rounded-full bg-fill-active",
          size === "sm" ? "h-1" : "h-1.5",
        )}
      >
        <ProgressPrimitive.Indicator
          className={cx(
            "h-full rounded-full",
            fill[tone],
            clamped === null
              ? "ui-indeterminate absolute"
              : "w-full transition-transform duration-(--duration-slow) ease-out",
          )}
          style={clamped === null ? undefined : { transform: `translateX(-${100 - clamped}%)` }}
        />
      </ProgressPrimitive.Root>
      {showValue && clamped !== null ? (
        <span className="w-10 shrink-0 text-end text-caption tabular-nums text-fg-2">
          {Math.round(clamped)}%
        </span>
      ) : null}
    </div>
  );
}
