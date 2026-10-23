import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

/**
 * Placeholder with the shape of the content that is loading. Use it instead of a spinner for anything
 * that takes longer than a moment. It pulses gently and sits still under prefers-reduced-motion.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cx("animate-pulse rounded-md bg-fill-active", className)}
      {...props}
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <Skeleton key={i} className={cx("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
