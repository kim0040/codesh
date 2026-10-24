import { createStore, type Store } from "../../lib/store";

export interface EditorInfo {
  line: number;
  col: number;
  selected: number;
  length: number;
  bytes: number;
}

export function createInfoStore(): Store<EditorInfo> {
  return createStore<EditorInfo>({ line: 1, col: 1, selected: 0, length: 0, bytes: 0 });
}

/**
 * Records the length of the document a view was just created with. The update listener only
 * reports changes, so without this the length reads 0 until the first cursor move.
 */
export function setInitialLength(info: Store<EditorInfo>, length: number): void {
  info.set((previous) => ({ ...previous, length }));
}

/** The "you're the only one here" card shows over an empty, editable share nobody else joined. */
export function showAloneHint(state: {
  participants: number;
  length: number;
  readOnly: boolean;
}): boolean {
  return state.participants <= 1 && state.length === 0 && !state.readOnly;
}
