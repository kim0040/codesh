import { useEffect, useRef } from "react";
import { type ShortcutId, shortcutOf } from "./shortcuts";

/**
 * Runs `handler` when the window gets one of the shortcuts in `ids`. The handler returns `false`
 * when it did not act (the key then keeps its browser meaning); otherwise the key press is
 * cancelled, which also stops macOS from typing the character an Option chord would produce.
 * Presses that CodeMirror already used (it cancels them) and keys of a running IME are skipped.
 */
export function useWindowShortcuts<Id extends ShortcutId>(
  ids: readonly Id[],
  handler: (id: Id, event: KeyboardEvent) => boolean | undefined,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  const list = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `list` is the content of `ids`
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const id = shortcutOf(event, ids);
      if (!id) return;
      if (latest.current(id, event) !== false) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [list]);
}
