import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { useFieldProps } from "./field.js";

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  /** Icon or text before the value (decorative; give the input its own label). */
  leading?: ReactNode;
  /** Icon, unit or button after the value. */
  trailing?: ReactNode;
  /** Classes for the outer frame. */
  frameClassName?: string;
}

const heights = { sm: "h-7", md: "h-8", lg: "h-10" } as const;

export function Input({
  size = "md",
  invalid,
  leading,
  trailing,
  className,
  frameClassName,
  ...props
}: InputProps) {
  const field = useFieldProps();
  const isInvalid = invalid ?? field["aria-invalid"] === true;
  return (
    <div
      data-invalid={isInvalid || undefined}
      data-disabled={props.disabled || undefined}
      className={cx(
        "flex w-full items-center gap-2 rounded-md border border-line-control bg-panel px-3 text-fg",
        "transition-[border-color,box-shadow] duration-(--duration-fast) ease-out",
        "hover:border-fg-3 focus-within:border-accent-text focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        "data-[invalid]:border-danger-text data-[disabled]:opacity-50 data-[disabled]:hover:border-line-control",
        "coarse:min-h-11",
        heights[size],
        frameClassName,
      )}
    >
      {leading ? <span className="flex shrink-0 text-fg-3 [&_svg]:size-4">{leading}</span> : null}
      <input
        {...field}
        {...props}
        className={cx(
          // 16px on touch screens stops iOS Safari from zooming the page on focus.
          "min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-fg-3 coarse:text-base",
          "disabled:cursor-not-allowed",
          className,
        )}
      />
      {trailing ? (
        <span className="flex shrink-0 items-center text-fg-3 [&_svg]:size-4">{trailing}</span>
      ) : null}
    </div>
  );
}
