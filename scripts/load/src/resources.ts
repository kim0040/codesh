import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Resource use of the server containers and of the host while a load test runs. */

export interface ServiceUsage {
  /** CPU in % of one core (`docker stats`), averaged over the samples. */
  cpuAvg: number;
  cpuPeak: number;
  memAvgMiB: number;
  memPeakMiB: number;
  samples: number;
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
  const perService = new Map<string, { cpu: number[]; mem: number[] }>();
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
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string };
        const service = serviceOf(row.Name, project);
        if (!service) continue;
        const entry = perService.get(service) ?? { cpu: [], mem: [] };
        entry.cpu.push(Number.parseFloat(row.CPUPerc) || 0);
        entry.mem.push(parseSize(row.MemUsage.split("/")[0] ?? ""));
        perService.set(service, entry);
      }
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

  const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const round = (x: number) => Math.round(x * 10) / 10;

  return {
    async stop(): Promise<ResourceReport> {
      stopped = true;
      await pending;
      void looping;
      const services: Record<string, ServiceUsage> = {};
      for (const [name, { cpu, mem }] of perService) {
        services[name] = {
          cpuAvg: round(avg(cpu)),
          cpuPeak: round(Math.max(0, ...cpu)),
          memAvgMiB: round(avg(mem)),
          memPeakMiB: round(Math.max(0, ...mem)),
          samples: cpu.length,
        };
      }
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
