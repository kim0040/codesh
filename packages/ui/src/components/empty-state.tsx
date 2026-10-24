import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";

export interface EmptyStateProps {
  /** Decorative icon (aria-hidden is applied). */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next step, usually a Button. */
  action?: ReactNode;
  /** Secondary link or button. */
  secondaryAction?: ReactNode;
  /** `danger` for errors the user can retry. */
  tone?: "neutral" | "danger";
  /** Heading level for the title. Defaults to h2; full-page screens use 1. */
  headingLevel?: 1 | 2 | 3 | 4;
  size?: "md" | "sm";
  className?: string;
}

/**
 * Empty lists, failed loads and "nothing here yet" panels: say what is missing, then give the next step.
 * Works down to 320px: the block is centred, text wraps and actions stack.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "neutral",
  headingLevel = 2,
  size = "md",
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cx(
        "mx-auto flex w-full max-w-sm flex-col items-center text-center",
        size === "md" ? "gap-3 px-4 py-12" : "gap-2 px-3 py-6",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cx(
            "mb-1 flex items-center justify-center rounded-full [&_svg]:size-5",
            size === "md" ? "size-12" : "size-10",
            tone === "danger" ? "bg-danger-soft text-danger-text" : "bg-fill-active text-fg-2",
          )}
        >
          {icon}
        </span>
      ) : null}
      <Heading className="text-title-sm font-semibold text-fg">{title}</Heading>
      {description ? <p className="text-body-sm text-fg-2">{description}</p> : null}
      {action || secondaryAction ? (
        <div className="mt-2 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
