/** The parts of a keyboard event that tell an input method (IME) apart from a plain key press. */
export interface ImeKeyEvent {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

/**
 * True while an input method (Korean, Japanese, Chinese) owns the key: Enter then confirms a
 * syllable, Escape cancels it, Tab picks a candidate. `isComposing` covers Chrome and Firefox;
 * Safari fires `compositionend` before the Enter that confirmed, so that keydown has
 * `isComposing: false` but still `keyCode: 229`. Shortcut chords (Ctrl or ⌘) never go through the
 * IME, so a 229 with either held is not composition.
 */
export function isImeKey(event: ImeKeyEvent): boolean {
  if (event.isComposing) return true;
  return event.keyCode === 229 && !event.ctrlKey && !event.metaKey;
}
