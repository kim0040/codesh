import { type RefObject, useEffect } from "react";

/** Pages shown so far in this document: the first one of a visit is the page load itself. */
let shown = 0;
/** What each mounted page decided, so React's development double run of an effect decides once. */
const decided = new WeakMap<object, boolean>();

/**
 * Whether the page was reached by following a link inside the app, not by loading it. A load leaves
 * the browser's own starting point (the skip link comes first) and needs nothing from us.
 *
 * Another page of the app was shown before, or the visit started on a page this hook is not on (the
 * editor) and the router has pushed entries since: a document opened by a plain navigation starts
 * at entry 0. A reload or Back/Forward load keeps its old entry number, so those count as loads.
 */
function arrivedByNavigation(): boolean {
  if (shown > 0) return true;
  const [load] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  const index = Number(window.history.state?.__TSR_index ?? 0);
  return (load?.type ?? "navigate") === "navigate" && index > 0;
}

/**
 * A page reached through the app starts at the top with focus on `target` (an element with
 * `tabIndex={-1}`), as a full page load would leave a reader. The link that was followed is gone by
 * now, so without this the focus falls back to the body and keyboard and screen-reader users lose
 * their place. Nothing scrolls because of the focus itself.
 */
export function useFocusOnArrival(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let move = decided.get(target);
    if (move === undefined) {
      move = arrivedByNavigation();
      decided.set(target, move);
      shown++;
    }
    if (!move) return;
    if (!window.location.hash) window.scrollTo(0, 0);
    target.current?.focus({ preventScroll: true });
  }, [target]);
}
