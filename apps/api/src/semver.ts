/** Just enough of Semantic Versioning 2.0.0 to order release tags (`v1.2.3`, `1.3.0-rc.1`). */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; empty for a release. */
  pre: string[];
}

const PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: string): SemVer | null {
  const match = PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Math.sign(Number(a) - Number(b));
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when `a` is older than `b`; build metadata is ignored. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  // A pre-release sorts before its release.
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const order = compareIdentifiers(a.pre[i] as string, b.pre[i] as string);
    if (order !== 0) return order;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

export const formatSemver = (v: SemVer) =>
  `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join(".")}` : ""}`;
