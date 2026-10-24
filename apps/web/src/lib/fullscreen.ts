/**
 * Element fullscreen with the prefix Safari still needs before 16.4 (macOS) and on iPad.
 * iPhone has no element fullscreen at all: callers keep their own full-viewport layout, so a
 * `false` from `requestFullscreen` is not an error.
 */

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export const FULLSCREEN_CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

export function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Resolves to whether the element is now fullscreen; never rejects. */
export async function requestFullscreen(element: HTMLElement): Promise<boolean> {
  const target = element as FullscreenElement;
  try {
    if (target.requestFullscreen) await target.requestFullscreen();
    else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    else return false;
    return fullscreenElement() === element;
  } catch {
    return false;
  }
}

export async function exitFullscreen(): Promise<void> {
  const doc = document as FullscreenDocument;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
  } catch {
    // Already out of fullscreen.
  }
}
