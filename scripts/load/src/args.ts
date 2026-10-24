import { parseArgs } from "node:util";

export interface Options {
  url: string;
  shares: number;
  /** Clients per share that type, the owner included. */
  writers: number;
  /** Clients per share that only read. */
  viewers: number;
  durationS: number;
  /** Markers typed per writer and second. */
  rate: number;
  /** Seconds to wait for convergence after the writers stopped. */
  settleS: number;
  /** Seconds a client gets to finish its initial sync. */
  connectTimeoutS: number;
  /** Parallel setup requests. */
  concurrency: number;
  metricsApi: string;
  metricsCollab: string;
  sampleS: number;
  keep: boolean;
  outDir: string | undefined;
}

export const USAGE = `usage: pnpm load -- --url http://host [--shares 100 --writers 5 --viewers 20 --duration 60]
  --url <url>            server (Caddy) base URL, default http://localhost
  --shares <n>           shares to create (default 10)
  --writers <n>          typing clients per share, owner included (default 2)
  --viewers <n>          read-only clients per share (default 5)
  --duration <s>         seconds the writers type (default 30)
  --rate <n>             markers per writer and second (default 5)
  --settle <s>           max seconds to wait for convergence after typing (default 15)
  --connect-timeout <s>  max seconds for one client to sync (default 20)
  --concurrency <n>      parallel setup requests (default 20)
  --metrics-api <url>    default <url>/metrics/api
  --metrics-collab <url> default <url>/metrics/collab
  --sample <s>           metrics sampling interval (default 10)
  --keep                 do not delete the shares afterwards
  --out <dir>            directory for load-<ts>.json (default <repo>/.box-out)`;

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
      shares: { type: "string" },
      writers: { type: "string" },
      viewers: { type: "string" },
      duration: { type: "string" },
      rate: { type: "string" },
      settle: { type: "string" },
      "connect-timeout": { type: "string" },
      concurrency: { type: "string" },
      "metrics-api": { type: "string" },
      "metrics-collab": { type: "string" },
      sample: { type: "string" },
      keep: { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return null;
  const url = (values.url ?? "http://localhost").replace(/\/+$/, "");
  return {
    url,
    shares: positive("shares", values.shares, 10),
    writers: positive("writers", values.writers, 2),
    viewers: positive("viewers", values.viewers, 5, 0),
    durationS: positive("duration", values.duration, 30),
    rate: positive("rate", values.rate, 5, 0.1),
    settleS: positive("settle", values.settle, 15, 0),
    connectTimeoutS: positive("connect-timeout", values["connect-timeout"], 20),
    concurrency: positive("concurrency", values.concurrency, 20),
    metricsApi: values["metrics-api"] ?? `${url}/metrics/api`,
    metricsCollab: values["metrics-collab"] ?? `${url}/metrics/collab`,
    sampleS: positive("sample", values.sample, 10),
    keep: values.keep ?? false,
    outDir: values.out,
  };
}
