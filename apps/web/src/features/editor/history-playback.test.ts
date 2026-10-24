import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { chunkStats, nextStepDelay, PLAYBACK_AHEAD, prefetchRange } from "./history-playback";

const doc = (text: string) => Text.of(text.split("\n"));
const stats = (before: string, after: string) => {
  const a = doc(before);
  const b = doc(after);
  return chunkStats(Chunk.build(a, b), a, b);
};

describe("prefetchRange", () => {
  it("keeps the diff base, the focus and the next version while paused", () => {
    expect(prefetchRange(5, 10, false)).toEqual([4, 5, 6]);
    expect(prefetchRange(0, 10, false)).toEqual([0, 1]);
    expect(prefetchRange(9, 10, false)).toEqual([8, 9]);
  });

  it("reaches ahead of the playhead while playing, within the timeline", () => {
    expect(prefetchRange(2, 30, true)).toHaveLength(PLAYBACK_AHEAD + 2);
    expect(prefetchRange(2, 30, true)[0]).toBe(1);
    expect(prefetchRange(27, 30, true)).toEqual([26, 27, 28, 29]);
    expect(prefetchRange(0, 0, true)).toEqual([]);
  });
});

describe("nextStepDelay", () => {
  it("keeps the beat when a version shows on time", () => {
    expect(nextStepDelay(1_000, 1_010, 225)).toBe(215);
  });

  it("still shows a late version for half a step", () => {
    expect(nextStepDelay(1_000, 1_400, 225)).toBe(112.5);
  });
});

describe("chunkStats", () => {
  it("counts changed lines on each side", () => {
    expect(stats("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
    expect(stats("a\nc", "a\nb1\nb2\nc")).toEqual({ added: 2, removed: 0 });
    expect(stats("a\nb\nc\n", "a\n")).toEqual({ added: 0, removed: 2 });
  });

  it("finds no changes between equal texts", () => {
    expect(stats("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a change on the last line without a trailing newline", () => {
    expect(stats("a\nb", "a\nbb")).toEqual({ added: 1, removed: 1 });
  });
});
