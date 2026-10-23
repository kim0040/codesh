import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export interface LanguageBadgeProps extends Omit<ComponentProps<"span">, "children"> {
  /** Programming language name, same in Korean and English UI ("Python"). */
  name: string;
  /** `#rrggbb` identity colour from the language registry. */
  color: string;
  /** `chip` draws a bordered pill; `inline` is just dot + name. */
  variant?: "inline" | "chip";
}

/**
 * Language identity: a colour dot plus the name. The dot is an extra cue, never the only one, so it
 * is hidden from assistive tech and carries a hairline ring to stay visible on very dark or light colours.
 */
export function LanguageBadge({
  name,
  color,
  variant = "inline",
  className,
  ...props
}: LanguageBadgeProps) {
  return (
    <span
      title={name}
      className={cx(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 text-label text-fg-2",
        variant === "chip" && "h-6 rounded-full border border-line bg-fill-hover px-2",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        style={{ backgroundColor: color }}
        className="size-2 shrink-0 rounded-full [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,var(--fg)_28%,transparent)]"
      />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
