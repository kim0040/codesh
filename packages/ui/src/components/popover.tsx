import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps extends ComponentProps<typeof PopoverPrimitive.Content> {
  container?: HTMLElement | null;
}

/** Non-modal floating panel (language picker, share link): Escape or an outside click closes it. */
export function PopoverContent({
  align = "center",
  sideOffset = 8,
  collisionPadding = 8,
  container,
  className,
  ...props
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cx(
          "ui-pop z-(--z-dropdown) w-72 max-w-[calc(100vw-1rem)] origin-(--radix-popover-content-transform-origin) rounded-lg border border-line bg-overlay p-3 text-body-sm text-fg shadow-3",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
