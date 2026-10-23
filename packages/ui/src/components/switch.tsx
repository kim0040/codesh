import { Switch as SwitchPrimitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useId } from "react";
import { cx } from "../lib/cx.js";

export interface SwitchProps extends ComponentProps<typeof SwitchPrimitive.Root> {
  /** Visible label. Without it, pass `aria-label`. */
  label?: ReactNode;
  description?: ReactNode;
}

export function Switch({ label, description, className, id, ...props }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? autoId;
  const descriptionId = `${switchId}-description`;

  const control = (
    <SwitchPrimitive.Root
      id={switchId}
      aria-describedby={description ? descriptionId : undefined}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-line-control bg-fill-active p-0.5",
        "transition-[background-color,border-color] duration-(--duration-normal) ease-out",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50",
        // Keep the 24px-tall visual, grow the touch area on phones.
        "coarse:after:absolute coarse:after:-inset-2 coarse:after:content-['']",
        !label && className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cx(
          "pointer-events-none block size-4 rounded-full bg-fg-2 shadow-1",
          "transition-[transform,background-color] duration-(--duration-normal) ease-spring",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-accent-fg",
        )}
      />
    </SwitchPrimitive.Root>
  );

  if (!label) return control;

  return (
    <div className={cx("flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col">
        <label htmlFor={switchId} className="text-body-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-caption text-fg-3">
            {description}
          </p>
        ) : null}
      </div>
      {control}
    </div>
  );
}
