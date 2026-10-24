import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

/** A row of buttons that filter or switch a view in place (no panels, so not Tabs). */
export function ToggleGroup({
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<"fieldset">, "aria-label"> & { label: string }) {
  return (
    <fieldset
      className={cx(
        "m-0 flex min-w-0 max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-lg border border-line bg-fill-hover p-0.5",
        className,
      )}
      {...props}
    >
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

export interface ToggleGroupItemProps extends Omit<ComponentProps<"button">, "aria-pressed"> {
  pressed: boolean;
}

export function ToggleGroupItem({
  pressed,
  className,
  type = "button",
  ...props
}: ToggleGroupItemProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-body-sm font-medium text-fg-2",
        "transition-[color,background-color] duration-(--duration-fast) ease-out hover:text-fg",
        "aria-pressed:bg-raised aria-pressed:text-fg aria-pressed:shadow-1 disabled:opacity-50 coarse:h-11",
        className,
      )}
      {...props}
    />
  );
}
