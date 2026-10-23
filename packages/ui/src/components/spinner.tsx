import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export interface SpinnerProps extends Omit<ComponentProps<"span">, "children"> {
  /** Accessible name announced to screen readers. */
  label: string;
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: "size-3.5", md: "size-4", lg: "size-5" } as const;

/**
 * Indeterminate activity for waits expected to finish in under a second (a button that is saving).
 * Anything longer should show a Skeleton (content shape) or a ProgressBar (known progress).
 * Under prefers-reduced-motion the ring stops turning and stays as a static arc.
 */
export function Spinner({ label, size = "md", className, ...props }: SpinnerProps) {
  return (
    <span role="status" className={cx("inline-flex shrink-0", className)} {...props}>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className={cx(sizes[size], "animate-spin")}
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
