import { Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Spinner } from "./spinner.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "soft" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "transition-[background-color,border-color,color,transform] duration-(--duration-fast) ease-out " +
  "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-1 hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "border border-line-strong bg-transparent text-fg hover:bg-fill-hover active:bg-fill-active",
  ghost: "bg-transparent text-fg-2 hover:bg-fill-hover hover:text-fg active:bg-fill-active",
  soft: "bg-accent-soft text-accent-text hover:bg-[color-mix(in_oklab,var(--accent-soft),var(--accent-text)_10%)] active:bg-[color-mix(in_oklab,var(--accent-soft),var(--accent-text)_17%)]",
  danger: "bg-danger text-danger-fg shadow-1 hover:bg-danger-hover active:bg-danger-active",
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-label coarse:min-h-10 [&_svg]:size-3.5",
  md: "h-8 px-3 text-body-sm coarse:min-h-11 [&_svg]:size-4",
  lg: "h-10 px-4 text-body-sm coarse:min-h-11 [&_svg]:size-4",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while keeping the button's width. Pair with `loadingLabel`. */
  loading?: boolean;
  /** Announced while `loading` (e.g. "Saving…"). */
  loadingLabel?: string;
  /** Icon before the label. */
  leading?: ReactNode;
  /** Icon after the label. */
  trailing?: ReactNode;
  /** Render as the child element (a router link) instead of a <button>. */
  asChild?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  leading,
  trailing,
  asChild = false,
  className,
  children,
  disabled,
  type = "button",
  onClick,
  ...props
}: ButtonProps) {
  const classes = cx(buttonBase, "relative", buttonVariants[variant], buttonSizes[size], className);

  if (asChild) {
    return (
      <Slot.Root className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      onClick={loading ? undefined : onClick}
      {...props}
    >
      <span className={cx("inline-flex items-center gap-2", loading && "invisible")}>
        {leading}
        {children}
        {trailing}
      </span>
      {loading ? (
        <span className="absolute inset-0 inline-flex items-center justify-center">
          <Spinner label={loadingLabel ?? "…"} size={size === "lg" ? "md" : "sm"} />
        </span>
      ) : null}
    </button>
  );
}
