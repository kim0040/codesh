import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Kbd } from "./kbd.js";

/** Mount once near the root. Hovering a second trigger within `skipDelayDuration` shows it instantly. */
export function TooltipProvider({
  delayDuration = 450,
  skipDelayDuration = 250,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Keyboard shortcut shown after the text, e.g. ["⌘", "K"]. */
  shortcut?: readonly string[];
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  open?: boolean;
  defaultOpen?: boolean;
  container?: HTMLElement | null;
  /** The trigger element (rendered as-is via asChild). */
  children: ReactNode;
}

/**
 * A tooltip repeats or extends a control's name; it never holds the only copy of important text.
 * It opens on hover and keyboard focus, closes on Escape, and stays open while the pointer is over it.
 */
export function Tooltip({
  content,
  shortcut,
  side = "top",
  align = "center",
  open,
  defaultOpen,
  container,
  children,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root open={open} defaultOpen={defaultOpen}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cx(
            "ui-tip z-(--z-tooltip) flex max-w-72 origin-(--radix-tooltip-content-transform-origin) items-center gap-2 rounded-md bg-fg px-2 py-1 text-caption text-bg shadow-2",
          )}
        >
          <span>{content}</span>
          {shortcut ? (
            <span className="flex gap-0.5">
              {shortcut.map((key) => (
                <Kbd key={key} tone="inverse">
                  {key}
                </Kbd>
              ))}
            </span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
