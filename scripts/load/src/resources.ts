import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Resource use of the server containers and of the host while a load test runs. */

export interface ContainerUsage {
  /** CPU in % of one core (`docker stats`), averaged over the samples. */
  cpuAvg: number;
  cpuPeak: number;
  memAvgMiB: number;
  memPeakMiB: number;
  samples: number;
}

/**
 * A service's containers added up at every sampling time (two replicas at 40% each are 80%), then
 * averaged and maxed over time. `containers` keeps each replica's own figures.
 */
export interface ServiceUsage extends ContainerUsage {
  replicas: number;
  containers: Record<string, ContainerUsage>;
}

/** One container's line of one `docker stats` reading. */
export interface ContainerSample {
  container: string;
  service: string;
  cpu: number;
  memMiB: number;
}

export interface HostUsage {
  cores: number;
  /** Busy share of all cores, in %. */
  cpuAvg: number;
  cpuPeak: number;
  memAvailableMinMiB: number;
}

export interface ResourceReport {
  project: string | null;
  services: Record<string, ServiceUsage>;
  host: HostUsage | null;
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  KiB: 1024,
  MB: 1e6,
  MiB: 1024 ** 2,
  GB: 1e9,
  GiB: 1024 ** 3,
};

/** `123.4MiB` -> MiB. */
export function parseSize(text: string): number {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  if (!match) return 0;
  return (Number(match[1]) * (UNITS[match[2] as string] ?? 1)) / 1024 ** 2;
}

/** `codesh-perf-collab-1` in project `codesh-perf` -> `collab`. */
export function serviceOf(container: string, project: string): string | null {
  if (!container.startsWith(`${project}-`)) return null;
  return container.slice(project.length + 1).replace(/-\d+$/, "");
}

const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (x: number) => Math.round(x * 10) / 10;

function usageOf(cpu: number[], mem: number[]): ContainerUsage {
  return {
    cpuAvg: round(avg(cpu)),
    cpuPeak: round(Math.max(0, ...cpu)),
    memAvgMiB: round(avg(mem)),
    memPeakMiB: round(Math.max(0, ...mem)),
    samples: cpu.length,
  };
}

/** Collects `docker stats` readings; each reading is all containers at one moment. */
export class UsageTracker {
  private readonly services = new Map<string, { cpu: number[]; mem: number[] }>();
  private readonly containers = new Map<
    string,
    { service: string; cpu: number[]; mem: number[] }
  >();

  add(reading: ContainerSample[]): void {
    const now = new Map<string, { cpu: number; mem: number }>();
    for (const row of reading) {
      const sum = now.get(row.service) ?? { cpu: 0, mem: 0 };
      sum.cpu += row.cpu;
      sum.mem += row.memMiB;
      now.set(row.service, sum);
      const own = this.containers.get(row.container) ?? { service: row.service, cpu: [], mem: [] };
      own.cpu.push(row.cpu);
      own.mem.push(row.memMiB);
      this.containers.set(row.container, own);
    }
    for (const [service, sum] of now) {
      const entry = this.services.get(service) ?? { cpu: [], mem: [] };
      entry.cpu.push(sum.cpu);
      entry.mem.push(sum.mem);
      this.services.set(service, entry);
    }
  }

  report(): Record<string, ServiceUsage> {
    const out: Record<string, ServiceUsage> = {};
    for (const [service, { cpu, mem }] of this.services) {
      const containers: Record<string, ContainerUsage> = {};
      for (const [name, own] of this.containers) {
        if (own.service === service) containers[name] = usageOf(own.cpu, own.mem);
      }
      out[service] = {
        ...usageOf(cpu, mem),
        replicas: Object.keys(containers).length,
        containers,
      };
    }
    return out;
  }
}

/**
 * The server budgets of docs/OPERATIONS.md §11.1 (CPU in % of one core, averaged over the run;
 * memory peak in MiB), for one share of 50 and for about 200 users. Services are totals over all
 * their containers. Above 300 clients there is no documented budget.
 */
export const RESOURCE_BUDGETS = {
  50: {
    collab: { cpu: 50, memMiB: 512 },
    api: { cpu: 25, memMiB: 256 },
    mongo: { cpu: 50, memMiB: 1024 },
    valkey: { cpu: 10, memMiB: 64 },
  },
  200: {
    collab: { cpu: 100, memMiB: 1024 },
    api: { cpu: 50, memMiB: 512 },
    mongo: { cpu: 100, memMiB: 2048 },
    valkey: { cpu: 25, memMiB: 128 },
  },
} as const;

export interface BudgetCheck {
  limit: number;
  /** Null when the service was never sampled: no data fails the budget. */
  value: number | null;
  ok: boolean;
}

/** Budget checks by name, or null when the client count has no documented budget. */
export function checkBudgets(
  services: Record<string, ServiceUsage>,
  clients: number,
): Record<string, BudgetCheck> | null {
  if (clients > 300) return null;
  const budgets = RESOURCE_BUDGETS[clients <= 100 ? 50 : 200];
  const checks: Record<string, BudgetCheck> = {};
  for (const [name, budget] of Object.entries(budgets)) {
    const usage = services[name];
    const seen = usage !== undefined && usage.samples > 0;
    checks[`${name}CpuPercent`] = {
      limit: budget.cpu,
      value: seen ? usage.cpuAvg : null,
      ok: seen && usage.cpuAvg <= budget.cpu,
    };
    checks[`${name}MemMiB`] = {
      limit: budget.memMiB,
      value: seen ? usage.memPeakMiB : null,
      ok: seen && usage.memPeakMiB <= budget.memMiB,
    };
  }
  return checks;
}

interface CpuTimes {
  busy: number;
  total: number;
}

async function hostCpu(): Promise<CpuTimes | null> {
  try {
    const line = (await readFile("/proc/stat", "utf8")).split("\n")[0] ?? "";
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    return { busy: total - idle, total };
  } catch {
    return null;
  }
}

async function memAvailableMiB(): Promise<number | null> {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(await readFile("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Samples `docker stats` for the containers of a compose project and the host's /proc every
 * `intervalS`. Without a project only the host is sampled (or nothing, off Linux).
 */
export function startResourceSampler(project: string | null, intervalS: number) {
  const usage = new UsageTracker();
  const hostSamples: number[] = [];
  const memSamples: number[] = [];
  let cores = 0;
  let previous: CpuTimes | null = null;
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();

  const sample = async () => {
    const cpu = await hostCpu();
    if (cpu && previous && cpu.total > previous.total) {
      hostSamples.push((100 * (cpu.busy - previous.busy)) / (cpu.total - previous.total));
    }
    previous = cpu;
    const mem = await memAvailableMiB();
    if (mem !== null) memSamples.push(mem);
    if (!project) return;
    try {
      const { stdout } = await run("docker", ["stats", "--no-stream", "--format", "{{json .}}"], {
        timeout: 15_000,
      });
      const reading: ContainerSample[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string };
        const service = serviceOf(row.Name, project);
        if (!service) continue;
        reading.push({
          container: row.Name,
          service,
          cpu: Number.parseFloat(row.CPUPerc) || 0,
          memMiB: parseSize(row.MemUsage.split("/")[0] ?? ""),
        });
      }
      usage.add(reading);
    } catch {
      // docker missing or busy: this sample has no container figures.
    }
  };

  const loop = async () => {
    try {
      cores = (await readFile("/proc/cpuinfo", "utf8")).match(/^processor\s/gm)?.length ?? 0;
    } catch {
      cores = 0;
    }
    previous = await hostCpu();
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, intervalS * 1000));
      if (stopped) break;
      pending = sample();
      await pending;
    }
  };
  const looping = loop();

  return {
    async stop(): Promise<ResourceReport> {
      stopped = true;
      await pending;
      void looping;
      const services = usage.report();
      const host =
        hostSamples.length === 0
          ? null
          : {
              cores,
              cpuAvg: round(avg(hostSamples)),
              cpuPeak: round(Math.max(...hostSamples)),
              memAvailableMinMiB: round(Math.min(...memSamples)),
            };
      return { project, services, host };
    },
  };
}
