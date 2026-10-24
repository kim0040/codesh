/** Percentile (nearest rank) of an ascending-sorted list; 0 for an empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    mean: sorted.length === 0 ? 0 : sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Marker typed by a writer: `«<writer>:<seq>»`. */
export const marker = (writer: number, seq: number) => `«${writer}:${seq}»`;

/** Every marker in `text`, as `[writer, seq]`. */
export function markersIn(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (const match of text.matchAll(/«(\d+):(\d+)»/g)) {
    found.push([Number(match[1]), Number(match[2])]);
  }
  return found;
}

/**
 * Sums the samples of Prometheus text lines for `name` (all label sets). Returns undefined when
 * the metric is absent.
 */
export function metricValue(text: string, name: string): number | undefined {
  let total: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name) || line.startsWith("#")) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== " " && rest[0] !== "{") continue;
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (Number.isFinite(value)) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Increase of a counter over a series of snapshots. A value lower than the one before is a
 * restarted process counting from zero again, as in Prometheus' `increase()`.
 */
export function increase(series: (Record<string, number> | null)[], name: string): number | null {
  const values = series.map((s) => s?.[name]).filter((v) => v !== undefined);
  if (values.length < 2) return null;
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    const [a, b] = [values[i - 1] as number, values[i] as number];
    total += b >= a ? b - a : b;
  }
  return total;
}
