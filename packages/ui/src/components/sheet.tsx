import { X } from "lucide-react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { useFocusReturn } from "../lib/focus-return.js";
import { isImeKey } from "../lib/ime.js";
import { DialogDescription, DialogOverlay, DialogTitle } from "./dialog.js";
import { IconButton } from "./icon-button.js";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export type SheetSide = "right" | "left" | "bottom";

const sides: Record<SheetSide, string> = {
  right: "ui-sheet-right inset-y-0 inset-e-0 w-full max-w-sm border-s rounded-s-xl",
  left: "ui-sheet-left inset-y-0 inset-s-0 w-full max-w-sm border-e rounded-e-xl",
  bottom: "ui-sheet-bottom inset-x-0 bottom-0 max-h-[85dvh] border-t rounded-t-xl",
};

export interface SheetContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  closeLabel: string;
  footer?: ReactNode;
  side?: SheetSide;
  container?: HTMLElement | null;
}

/**
 * Edge-anchored panel for settings, history and the participant list. Same focus handling as Dialog.
 * On narrow screens `bottom` is the natural choice; `right` fills the whole width under 24rem.
 */
export function SheetContent({
  title,
  description,
  hideTitle,
  closeLabel,
  footer,
  side = "right",
  container,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  ...props
}: SheetContentProps) {
  const focusReturn = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cx(
          "fixed z-(--z-modal) flex flex-col border-line bg-overlay text-fg shadow-4",
          sides[side],
          className,
        )}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...props}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          // Escape cancels an IME composition; it must not also close the panel.
          if (isImeKey(event)) event.preventDefault();
          else onEscapeKeyDown?.(event);
        }}
      >
        {side === "bottom" ? (
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong" />
        ) : null}
        <div className="flex flex-col gap-1 px-5 pt-5">
          {hideTitle ? (
            <VisuallyHidden.Root asChild>
              <DialogTitle>{title}</DialogTitle>
            </VisuallyHidden.Root>
          ) : (
            <DialogTitle>{title}</DialogTitle>
          )}
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        ) : null}
        <DialogPrimitive.Close asChild>
          <IconButton aria-label={closeLabel} size="sm" className="absolute inset-e-3 top-3">
            <X aria-hidden="true" />
          </IconButton>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
