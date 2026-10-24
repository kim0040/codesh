import { X } from "lucide-react";
import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { useFocusReturn } from "../lib/focus-return.js";
import { isImeKey } from "../lib/ime.js";
import { IconButton } from "./icon-button.js";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cx("pe-8 text-title-sm font-semibold text-fg", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cx("text-body-sm text-fg-2", className)} {...props} />
  );
}

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cx("ui-fade fixed inset-0 z-(--z-overlay) bg-scrim", className)}
      {...props}
    />
  );
}

export interface DialogContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> {
  /** Required: every dialog is named. */
  title: ReactNode;
  description?: ReactNode;
  /** Keep the title for screen readers only (when the body already shows a heading). */
  hideTitle?: boolean;
  /** Accessible name of the close button. */
  closeLabel: string;
  /** Buttons row, right-aligned. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  container?: HTMLElement | null;
}

const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl", xl: "max-w-4xl" } as const;

/**
 * Modal dialog: focus is trapped, Escape closes, focus returns to the trigger or, when opened from code, to the element that had it. Sized in rem with a
 * 1rem margin so it fits a 320px screen; the body scrolls if the content is taller than the screen.
 */
export function DialogContent({
  title,
  description,
  hideTitle,
  closeLabel,
  footer,
  size = "md",
  container,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  ...props
}: DialogContentProps) {
  const focusReturn = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cx(
          "ui-dialog fixed inset-0 z-(--z-modal) m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] flex-col rounded-xl border border-line bg-overlay text-fg [box-shadow:var(--edge),var(--elev-4)]",
          widths[size],
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
        {footer ? <div className="flex flex-wrap justify-end gap-2 px-5 pb-5">{footer}</div> : null}
        <DialogPrimitive.Close asChild>
          <IconButton aria-label={closeLabel} size="sm" className="absolute inset-e-3 top-3">
            <X aria-hidden="true" />
          </IconButton>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
