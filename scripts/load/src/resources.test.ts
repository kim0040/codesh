import { describe, expect, it } from "vitest";
import { checkBudgets, parseSize, serviceOf, UsageTracker } from "./resources.js";
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

describe("UsageTracker", () => {
  const row = (container: string, cpu: number, memMiB: number) => ({
    container,
    service: "collab",
    cpu,
    memMiB,
  });

  it("adds the containers of a service up at each sample before averaging over time", () => {
    const tracker = new UsageTracker();
    tracker.add([row("p-collab-1", 40, 200), row("p-collab-2", 40, 200)]);
    tracker.add([row("p-collab-1", 60, 100), row("p-collab-2", 10, 300)]);
    const collab = tracker.report().collab;
    // Samples add up to 80% / 400 MiB and 70% / 400 MiB: not 50% / 300 MiB of one container.
    expect(collab?.replicas).toBe(2);
    expect(collab?.samples).toBe(2);
    expect(collab?.cpuAvg).toBe(75);
    expect(collab?.cpuPeak).toBe(80);
    expect(collab?.memPeakMiB).toBe(400);
    // Each container keeps its own series.
    expect(collab?.containers["p-collab-1"]?.cpuPeak).toBe(60);
    expect(collab?.containers["p-collab-2"]?.memPeakMiB).toBe(300);
  });

  it("counts a service with one container as one replica", () => {
    const tracker = new UsageTracker();
    tracker.add([row("p-collab-1", 20, 100)]);
    expect(tracker.report().collab?.replicas).toBe(1);
  });
});

describe("checkBudgets", () => {
  const tracked = (cpu: number, memMiB: number) => {
    const tracker = new UsageTracker();
    const row = (service: string) => ({ container: `p-${service}-1`, service, cpu, memMiB });
    tracker.add(["collab", "api", "mongo", "valkey"].map(row));
    return tracker.report();
  };

  it("passes a run inside the budget of 50 users and fails one over it", () => {
    const within = checkBudgets(tracked(5, 50), 50);
    expect(Object.values(within ?? {}).every((c) => c.ok)).toBe(true);
    const over = checkBudgets(tracked(60, 50), 50);
    expect(over?.collabCpuPercent?.ok).toBe(false);
    expect(over?.apiCpuPercent?.ok).toBe(false);
    expect(over?.valkeyMemMiB?.ok).toBe(true);
  });

  it("uses the larger budget for about 200 users and none above 300", () => {
    expect(checkBudgets(tracked(60, 50), 250)?.collabCpuPercent?.ok).toBe(true);
    expect(checkBudgets(tracked(5, 50), 301)).toBeNull();
  });

  it("fails a service that was never sampled", () => {
    const tracker = new UsageTracker();
    tracker.add([{ container: "p-collab-1", service: "collab", cpu: 1, memMiB: 1 }]);
    const checks = checkBudgets(tracker.report(), 50);
    expect(checks?.collabCpuPercent?.ok).toBe(true);
    expect(checks?.mongoMemMiB).toEqual({ limit: 1024, value: null, ok: false });
  });
});
