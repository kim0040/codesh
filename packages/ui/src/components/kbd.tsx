import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export interface KbdProps extends ComponentProps<"kbd"> {
  /** `inverse` for use on the inverted tooltip surface. */
  tone?: "default" | "inverse";
}

export function Kbd({ tone = "default", className, ...props }: KbdProps) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-mono text-caption leading-none",
        tone === "default"
          ? "border border-line-strong border-b-2 bg-raised text-fg-2"
          : "bg-bg/15 text-bg",
        className,
      )}
      {...props}
    />
  );
}

/** A key combination such as ⌘ K, one keycap per entry. */
export function KbdGroup({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-0.5", className)}>
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}
