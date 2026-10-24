import { describe, expect, it } from "vitest";
import { parseSize, serviceOf } from "./resources.js";
import { increase } from "./stats.js";

describe("parseSize", () => {
  it("reads docker stats sizes in MiB", () => {
    expect(parseSize("512MiB")).toBe(512);
    expect(parseSize("1.5GiB")).toBe(1536);
    expect(parseSize("2048KiB")).toBe(2);
    expect(parseSize("garbage")).toBe(0);
  });
});

describe("serviceOf", () => {
  it("names the compose service of a container in the project", () => {
    expect(serviceOf("codesh-perf-collab-1", "codesh-perf")).toBe("collab");
    expect(serviceOf("codesh-perf-mongo-users-1", "codesh-perf")).toBe("mongo-users");
    expect(serviceOf("codesh-preview-collab-1", "codesh-perf")).toBeNull();
  });
});

describe("increase", () => {
  it("adds the steps of a counter and restarts from zero after a reset", () => {
    const series = [{ c: 10 }, { c: 15 }, { c: 4 }, { c: 6 }];
    // 10 -> 15 (+5), restart to 4 (+4), 4 -> 6 (+2).
    expect(increase(series, "c")).toBe(11);
  });

  it("skips missing snapshots and needs two values", () => {
    expect(increase([{ c: 1 }, null, { c: 3 }], "c")).toBe(2);
    expect(increase([{ c: 1 }], "c")).toBeNull();
  });
});
