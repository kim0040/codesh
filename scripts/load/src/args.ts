import { parseArgs } from "node:util";
import { type Plan, SCENARIOS, type Storm } from "./scenarios.js";

export interface Options {
  url: string;
  /** A name from SCENARIOS, or `custom` for the --shares/--writers/--viewers flags. */
  scenario: string;
  /** Tag of this run in the file name and the report, e.g. `before` or `after`. */
  label: string;
  shares: number;
  /** Clients per share that type, the owner included. */
  writers: number;
  /** Clients per share that only read. */
  viewers: number;
  durationS: number | undefined;
  /** Markers typed per writer and second. */
  rate: number;
  /** Cursor moves per viewer and second. */
  cursorRate: number;
  storm: Storm["kind"] | undefined;
  stormAtS: number | undefined;
  restartCommand: string | undefined;
  /** Seconds to wait for convergence after the writers stopped. */
  settleS: number;
  /** Seconds a client gets to finish its initial sync. */
  connectTimeoutS: number;
  /** Parallel setup requests. */
  concurrency: number;
  metricsApi: string;
  metricsCollab: string;
  sampleS: number;
  /** Compose project whose containers `docker stats` samples. */
  dockerProject: string | undefined;
  /** Client threads; default one per CPU. */
  threads: number | undefined;
  keep: boolean;
  outDir: string | undefined;
}

export const USAGE = `usage: pnpm load -- --url http://host [--scenario single-share-50 | lab-50 | reconnect-storm | mixed-200]
  --url <url>            server (Caddy) base URL, default http://localhost
  --scenario <name>      ${Object.keys(SCENARIOS).join(", ")} or custom (default custom)
  --label <tag>          tag in the result file name and report, e.g. before or after (default run)
  --duration <s>         seconds the writers type (default: the scenario's, 30 for custom)
  --storm <kind>         drop (every socket dies at once) or restart (runs --restart-cmd)
  --storm-at <s>         seconds into typing when the storm hits (default 15)
  --restart-cmd <sh>     shell command for --storm restart, e.g. "docker restart codesh-perf-collab-1"
  --docker-project <p>   compose project to sample with docker stats during the run
  --threads <n>          client threads (default one per CPU, at most one per client)
  custom scenario:
  --shares <n>           shares to create (default 10)
  --writers <n>          typing clients per share, owner included (default 2)
  --viewers <n>          read-only clients per share (default 5)
  --rate <n>             markers per writer and second (default 5)
  --cursor-rate <n>      cursor moves per viewer and second (default 0)
  common:
  --settle <s>           max seconds to wait for convergence after typing (default 15)
  --connect-timeout <s>  max seconds for one client to sync (default 20)
  --concurrency <n>      parallel setup requests (default 20)
  --metrics-api <url>    default <url>/metrics/api
  --metrics-collab <url> default <url>/metrics/collab
  --sample <s>           metrics and resource sampling interval (default 5)
  --keep                 do not delete the shares afterwards
  --out <dir>            directory for <scenario>-<label>-<ts>.json (default <repo>/.box-out/perf)`;

function positive(name: string, value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`--${name} must be >= ${min}`);
  return parsed;
}

export function parseOptions(argv: string[]): Options | null {
  // `pnpm load -- --shares 1` hands the script a leading "--".
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      scenario: { type: "string" },
      label: { type: "string" },
      shares: { type: "string" },
      writers: { type: "string" },
      viewers: { type: "string" },
      duration: { type: "string" },
      rate: { type: "string" },
      "cursor-rate": { type: "string" },
      storm: { type: "string" },
      "storm-at": { type: "string" },
      "restart-cmd": { type: "string" },
      settle: { type: "string" },
      "connect-timeout": { type: "string" },
      concurrency: { type: "string" },
      "metrics-api": { type: "string" },
      "metrics-collab": { type: "string" },
      sample: { type: "string" },
      "docker-project": { type: "string" },
      threads: { type: "string" },
      keep: { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return null;
  const url = (values.url ?? "http://localhost").replace(/\/+$/, "");
  const scenario = values.scenario ?? "custom";
  if (scenario !== "custom" && !(scenario in SCENARIOS)) {
    throw new Error(`--scenario must be one of ${Object.keys(SCENARIOS).join(", ")} or custom`);
  }
  const storm = values.storm;
  if (storm !== undefined && storm !== "drop" && storm !== "restart") {
    throw new Error("--storm must be drop or restart");
  }
  if (storm === "restart" && !values["restart-cmd"]) {
    throw new Error("--storm restart needs --restart-cmd");
  }
  const label = values.label ?? "run";
  if (!/^[\w.-]{1,40}$/.test(label)) throw new Error("--label: letters, digits, . _ - only");
  return {
    url,
    scenario,
    label,
    shares: positive("shares", values.shares, 10),
    writers: positive("writers", values.writers, 2),
    viewers: positive("viewers", values.viewers, 5, 0),
    durationS:
      values.duration === undefined ? undefined : positive("duration", values.duration, 30),
    rate: positive("rate", values.rate, 5, 0.1),
    cursorRate: positive("cursor-rate", values["cursor-rate"], 0, 0),
    storm,
    stormAtS:
      values["storm-at"] === undefined ? undefined : positive("storm-at", values["storm-at"], 15),
    restartCommand: values["restart-cmd"],
    settleS: positive("settle", values.settle, 15, 0),
    connectTimeoutS: positive("connect-timeout", values["connect-timeout"], 20),
    concurrency: positive("concurrency", values.concurrency, 20),
    metricsApi: values["metrics-api"] ?? `${url}/metrics/api`,
    metricsCollab: values["metrics-collab"] ?? `${url}/metrics/collab`,
    sampleS: positive("sample", values.sample, 5),
    dockerProject: values["docker-project"],
    threads: values.threads === undefined ? undefined : positive("threads", values.threads, 1),
    keep: values.keep ?? false,
    outDir: values.out,
  };
}

/** The scenario's plan with the command-line overrides applied. */
export function planOf(opts: Options): Plan {
  const base =
    opts.scenario === "custom"
      ? {
          groups: [
            {
              kind: "share" as const,
              name: "custom",
              shares: opts.shares,
              writers: opts.writers,
              viewers: opts.viewers,
              typeRate: opts.rate,
              cursorRate: opts.cursorRate,
            },
          ],
          durationS: 30,
        }
      : (SCENARIOS[opts.scenario] as Omit<Plan, "scenario">);
  const kind = opts.storm ?? base.storm?.kind;
  const storm: Storm | undefined = kind
    ? {
        kind,
        atS: opts.stormAtS ?? base.storm?.atS ?? 15,
        ...(opts.restartCommand ? { command: opts.restartCommand } : {}),
      }
    : undefined;
  return {
    scenario: opts.scenario,
    groups: base.groups,
    durationS: opts.durationS ?? base.durationS,
    ...(storm ? { storm } : {}),
  };
}
