import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { buttonBase, buttonVariants } from "./button.js";

export type IconButtonSize = "xs" | "sm" | "md" | "lg";

/** `xs` is 24px, the smallest hit area WCAG 2.2 (2.5.8) allows; coarse pointers get 44px. */
const sizes: Record<IconButtonSize, string> = {
  xs: "size-6 coarse:size-10 [&_svg]:size-3.5",
  sm: "size-7 coarse:size-10 [&_svg]:size-4",
  md: "size-8 coarse:size-11 [&_svg]:size-4",
  lg: "size-10 coarse:size-11 [&_svg]:size-5",
};

export interface IconButtonProps extends Omit<ComponentProps<"button">, "aria-label" | "children"> {
  /** Required: an icon alone has no accessible name. */
  "aria-label": string;
  variant?: "ghost" | "secondary" | "soft" | "primary" | "danger";
  size?: IconButtonSize;
  /** Toggle state; sets aria-pressed. */
  pressed?: boolean;
  children: ReactNode;
}

export function IconButton({
  variant = "ghost",
  size = "md",
  pressed,
  className,
  type = "button",
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      data-pressed={pressed || undefined}
      className={cx(
        buttonBase,
        buttonVariants[variant],
        sizes[size],
        "px-0 data-[pressed]:bg-fill-selected data-[pressed]:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
