import { readFileSync } from "node:fs";

/**
 * The product version: the root package.json `version` (the one source of truth). The image has no
 * root package.json, so its Dockerfile writes that value to /app/VERSION at build time.
 */
function readVersion(): string {
  const candidates = [
    new URL("../VERSION", import.meta.url),
    new URL("../../../package.json", import.meta.url),
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, "utf8").trim();
      const value = file.pathname.endsWith(".json")
        ? (JSON.parse(text) as { version?: unknown }).version
        : text;
      if (typeof value === "string" && value) return value;
    } catch {
      // Try the next place.
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();
