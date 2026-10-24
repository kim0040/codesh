import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";

/** Pure pieces of history playback (no React), so they can be tested on their own. */

/** Versions fetched ahead of the playhead while playing; also bounds the requests in flight. */
export const PLAYBACK_AHEAD = 6;

/**
 * Indexes of the versions worth having in memory around `focus`: the one before it (the diff
 * base), the focused one, and the next one (or the next few while playing). In timeline order.
 */
export function prefetchRange(focus: number, length: number, playing: boolean): number[] {
  if (length === 0) return [];
  const from = Math.max(0, focus - 1);
  const to = Math.min(length - 1, focus + (playing ? PLAYBACK_AHEAD : 1));
  const range: number[] = [];
  for (let index = from; index <= to; index++) range.push(index);
  return range;
}

/**
 * Milliseconds until the next step. Steps keep to the beat set when the previous one was issued,
 * so render time does not add up over a long playback; a version that arrived late still stays
 * on screen for half a step before the next one replaces it.
 */
export function nextStepDelay(issuedAt: number, now: number, stepMs: number): number {
  return Math.max(issuedAt + stepMs - now, stepMs / 2, 0);
}

/** Added and removed line counts from the chunks a merge view already computed. */
export function chunkStats(
  chunks: readonly Chunk[],
  a: Text,
  b: Text,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const chunk of chunks) {
    if (chunk.toA > chunk.fromA) {
      removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
    }
    if (chunk.toB > chunk.fromB) {
      added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
    }
  }
  return { added, removed };
}
