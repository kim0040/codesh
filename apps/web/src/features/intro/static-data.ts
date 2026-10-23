/*
 * Colours the page needs before the editor chunk has loaded. The values mirror @codesh/highlight
 * (slate in dark mode, paper in light mode) so the first paint does not pull CodeMirror into the
 * route's main chunk; static-data.test.ts fails if they drift from the package.
 */
import type { CSSProperties } from "react";

export interface LangChip {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

export const LANGS: readonly LangChip[] = [
  { id: "typescript", name: "TypeScript", color: "#3178c6" },
  { id: "python", name: "Python", color: "#3572A5" },
  { id: "go", name: "Go", color: "#00ADD8" },
  { id: "sql", name: "SQL", color: "#e38c00" },
  { id: "javascript", name: "JavaScript", color: "#f1e05a" },
  { id: "java", name: "Java", color: "#b07219" },
  { id: "kotlin", name: "Kotlin", color: "#A97BFF" },
  { id: "rust", name: "Rust", color: "#dea584" },
  { id: "cpp", name: "C++", color: "#f34b7d" },
  { id: "swift", name: "Swift", color: "#F05138" },
  { id: "php", name: "PHP", color: "#4F5D95" },
  { id: "html", name: "HTML", color: "#e34c26" },
];

export function lang(id: string): LangChip {
  const found = LANGS.find((chip) => chip.id === id);
  if (!found) throw new Error(`unknown language chip "${id}"`);
  return found;
}

/** [token, dark (slate), light (paper)] */
export const EDITOR_COLORS = [
  ["bg", "#111419", "#fbfaf7"],
  ["fg", "#e1e5eb", "#20242b"],
  ["keyword", "#cba1fa", "#7328ae"],
  ["string", "#7cd591", "#046a2f"],
  ["comment", "#8997a8", "#5a6472"],
  ["number", "#fda669", "#9c4700"],
  ["type", "#e3d372", "#6f5305"],
  ["function", "#86bafd", "#0b58bb"],
  ["variable", "#d6d1fe", "#36354c"],
  ["property", "#65d0dc", "#0b6a73"],
  ["operator", "#6db2b6", "#1c4b4b"],
  ["tag", "#fb979a", "#b52f4e"],
  ["attribute", "#f9add0", "#9e366f"],
] as const;

/** `--ed-bg`, `--ed-keyword`, … as `light-dark()` pairs; set once on the page root. */
export const editorVars: CSSProperties = Object.fromEntries(
  EDITOR_COLORS.map(([name, dark, light]) => [`--ed-${name}`, `light-dark(${light}, ${dark})`]),
);
