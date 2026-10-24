import { useState } from "react";

/** The part of an element that focus return needs; real elements and test doubles both fit. */
export interface Focusable {
  focus(): void;
  readonly isConnected: boolean;
}

interface AutoFocusEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export interface FocusReturn {
  /** Call when the panel opens, before focus moves into it. */
  onOpenAutoFocus(event: AutoFocusEvent): void;
  /** Call when the panel closes; puts focus back on the element that had it before the open. */
  onCloseAutoFocus(event: AutoFocusEvent): void;
}

/**
 * Remembers which element had focus when a panel opened and gives it back on close. Radix only
 * restores focus to a `Trigger`, and panels here are opened from code (shortcuts, menus), so with
 * no trigger focus would fall to <body> and keyboard users would start again from the top.
 */
export function createFocusReturn(getActive: () => Focusable | null): FocusReturn {
  let opener: Focusable | null = null;
  return {
    onOpenAutoFocus() {
      opener = getActive();
    },
    onCloseAutoFocus(event) {
      const target = opener;
      opener = null;
      // Leave Radix's own handling (the trigger) alone when someone already took over, or when the
      // opener is gone (a menu item that closed with its menu).
      if (event.defaultPrevented || !target?.isConnected) return;
      event.preventDefault();
      target.focus();
    },
  };
}

function activeElement(): Focusable | null {
  const element = document.activeElement;
  return element instanceof HTMLElement && element !== document.body ? element : null;
}

type AutoFocusHandler = (event: Event) => void;

/** Focus return for a Dialog or Sheet panel; the caller's own handlers still run. */
export function useFocusReturn(handlers: {
  onOpenAutoFocus?: AutoFocusHandler;
  onCloseAutoFocus?: AutoFocusHandler;
}): { onOpenAutoFocus: AutoFocusHandler; onCloseAutoFocus: AutoFocusHandler } {
  const [focusReturn] = useState(() => createFocusReturn(activeElement));
  return {
    onOpenAutoFocus(event) {
      focusReturn.onOpenAutoFocus(event);
      handlers.onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event) {
      handlers.onCloseAutoFocus?.(event);
      focusReturn.onCloseAutoFocus(event);
    },
  };
}
