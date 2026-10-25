import { describe, expect, it } from "vitest";
import { marker, markersIn, metricValue, percentile, summarize } from "./stats.js";

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const data = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(data, 50)).toBe(50);
    expect(percentile(data, 95)).toBe(95);
    expect(percentile(data, 99)).toBe(99);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 99)).toBe(7);
  });

  it("summarizes unsorted samples", () => {
    const s = summarize([30, 10, 20]);
    expect(s).toMatchObject({ count: 3, min: 10, max: 30, p50: 20, mean: 20 });
  });
});

describe("markers", () => {
  it("finds the markers a writer typed", () => {
    expect(markersIn(`a${marker(3, 12)}b${marker(0, 1)}`)).toEqual([
      [3, 12],
      [0, 1],
    ]);
  });
});

describe("metricValue", () => {
  const text = [
    "# HELP gachipad_collab_connections Open document connections",
    "# TYPE gachipad_collab_connections gauge",
    "gachipad_collab_connections 42",
    'gachipad_collab_updates_total{origin="connection"} 10',
    'gachipad_collab_updates_total{origin="redis"} 5',
    "gachipad_collab_connections_extra 9",
  ].join("\n");

  it("reads a gauge, sums label sets and ignores name prefixes", () => {
    expect(metricValue(text, "gachipad_collab_connections")).toBe(42);
    expect(metricValue(text, "gachipad_collab_updates_total")).toBe(15);
    expect(metricValue(text, "missing")).toBeUndefined();
  });
});
