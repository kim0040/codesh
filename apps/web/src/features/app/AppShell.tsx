import { Toaster } from "@codesh/ui";
import { type ReactNode, useEffect } from "react";
import { retainEvents } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { openPalette, openShortcuts } from "../../lib/overlays";
import { TemplatePicker } from "../start/TemplatePicker";
import { CommandPalette } from "./CommandPalette";
import { EventToasts } from "./EventToasts";
import { ShortcutSheet } from "./ShortcutSheet";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** App-wide pieces: the event stream, toasts, the command palette and the shortcut sheet. */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useT();

  useEffect(() => retainEvents(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        openShortcuts();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <a
        href="#main"
        className="sr-only z-(--z-toast) rounded-md bg-accent px-3 py-2 text-body-sm text-accent-fg focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        {t("a11y.skipToContent")}
      </a>
      {children}
      <Toaster label={t("a11y.toastRegion")} closeLabel={t("a11y.dismissToast")} />
      <EventToasts />
      <CommandPalette />
      <ShortcutSheet />
      <TemplatePicker />
    </>
  );
}
