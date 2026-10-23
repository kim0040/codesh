import type { CSSProperties } from "react";

/** Spread onto an element to fade and rise it in when it scrolls into view (see useScrollReveal). */
export function reveal(delayMs = 0): { "data-reveal": ""; style: CSSProperties } {
  return { "data-reveal": "", style: { "--d": `${delayMs}ms` } as CSSProperties };
}
