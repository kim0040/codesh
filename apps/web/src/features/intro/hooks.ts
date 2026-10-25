import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMedia(query: string, callback: () => void): () => void {
  const list = window.matchMedia(query);
  list.addEventListener("change", callback);
  return () => list.removeEventListener("change", callback);
}

/** True when the visitor asked the system for less motion. Server-safe: false until mounted. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => subscribeMedia(REDUCED_QUERY, callback),
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/** True while the media query matches. */
export function useMatchMedia(query: string): boolean {
  return useSyncExternalStore(
    (callback) => subscribeMedia(query, callback),
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export type Appearance = "dark" | "light";

function readAppearance(): Appearance {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function subscribeAppearance(callback: () => void): () => void {
  const list = window.matchMedia("(prefers-color-scheme: light)");
  list.addEventListener("change", callback);
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    list.removeEventListener("change", callback);
    observer.disconnect();
  };
}

/** The theme the page currently renders: `data-theme` on <html> wins, else the OS setting. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, readAppearance, () => "dark");
}

/** True while the element is on screen (with a margin), so loops can stop when nobody sees them. */
export function useInView<T extends Element>(
  ref: RefObject<T | null>,
  rootMargin = "0px",
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/** True while the tab is visible. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Scroll reveal: every `[data-reveal]` inside `root` gets `data-in` the first time it nears the
 * viewport. CSS animates opacity and transform only, and only once `data-reveal-ready` is on the
 * root, so a page whose script never gets this far stays fully visible. Anything already on screen
 * or scrolled past (a restored scroll position, an anchor jump) is shown at once, and printing
 * shows everything. Reduced motion and a missing IntersectionObserver show everything too.
 */
export function useScrollReveal(root: RefObject<HTMLElement | null>, reduced: boolean) {
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const targets = Array.from(container.querySelectorAll<HTMLElement>("[data-reveal]"));
    const show = (node: HTMLElement) => {
      node.dataset.in = "";
    };
    const showAll = () => {
      for (const node of targets) show(node);
    };
    if (reduced || typeof IntersectionObserver === "undefined") {
      showAll();
      return;
    }
    container.setAttribute("data-reveal-ready", "");
    // Reading layout here also settles the hidden state before the first paint, so nothing fades out.
    const fold = window.innerHeight * 0.92;
    const waiting = targets.filter((node) => {
      if (node.getBoundingClientRect().top >= fold) return true;
      show(node);
      return false;
    });
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // Scrolled past without ever intersecting: show it, or it would be blank on the way back.
          if (!entry.isIntersecting && entry.boundingClientRect.top >= 0) continue;
          show(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const node of waiting) observer.observe(node);
    window.addEventListener("beforeprint", showAll);
    return () => {
      observer.disconnect();
      window.removeEventListener("beforeprint", showAll);
      container.removeAttribute("data-reveal-ready");
    };
  }, [root, reduced]);
}

/** Scroll distance in one direction before the header hides or returns, so small wobbles do not flicker it. */
const HEADER_TRAVEL = 8;

/**
 * Sticky header that slides away when scrolling down and returns on any scroll up. It stays shown
 * near the top of the page and while focus is inside it. State goes straight onto the element as
 * `data-hidden` / `data-raised` (CSS does the rest), so scrolling never re-renders React.
 */
export function useHidingHeader<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const header = ref.current;
    if (!header) return;
    let lastY = window.scrollY;
    let travel = 0;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = Math.max(0, window.scrollY);
      const delta = y - lastY;
      lastY = y;
      // A direction change restarts the count.
      if (delta !== 0) travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
      let hidden = header.hasAttribute("data-hidden");
      if (
        y < header.offsetHeight ||
        header.matches(":focus-within") ||
        header.hasAttribute("data-menu") ||
        travel <= -HEADER_TRAVEL
      ) {
        hidden = false;
      } else if (travel >= HEADER_TRAVEL) {
        hidden = true;
      }
      header.toggleAttribute("data-hidden", hidden);
      header.toggleAttribute("data-raised", y > 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onFocusIn = () => header.removeAttribute("data-hidden");
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    header.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("scroll", onScroll);
      header.removeEventListener("focusin", onFocusIn);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return ref;
}
