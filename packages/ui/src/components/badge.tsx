import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const soft: Record<BadgeTone, string> = {
  neutral: "bg-fill-active text-fg-2",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-soft text-success-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  info: "bg-info-soft text-info-text",
};

const outline: Record<BadgeTone, string> = {
  neutral: "border border-line-strong text-fg-2",
  accent: "border border-accent-text/50 text-accent-text",
  success: "border border-success-text/50 text-success-text",
  warning: "border border-warning-text/50 text-warning-text",
  danger: "border border-danger-text/50 text-danger-text",
  info: "border border-info-text/50 text-info-text",
};

export interface BadgeProps extends ComponentProps<"span"> {
  tone?: BadgeTone;
  variant?: "soft" | "outline";
  size?: "sm" | "md";
}

/** Short status label. Colour supports the text, never replaces it. */
export function Badge({
  tone = "neutral",
  variant = "soft",
  size = "md",
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm font-medium [&_svg]:size-3",
        size === "sm" ? "h-4 px-1 text-[0.6875rem]" : "h-5 px-1.5 text-caption",
        variant === "soft" ? soft[tone] : outline[tone],
        className,
      )}
      {...props}
    />
  );
}
