import { defineConfig } from "@playwright/test";

/**
 * Browser perf specs (docs/OPERATIONS.md §11.3). They run against a production build, normally the
 * throwaway stack of `scripts/load/perf-stack.sh up` (E2E_PERF_URL, default http://localhost:8850),
 * not the dev servers of the end-to-end suite: React's development build would distort the numbers.
 */
export default defineConfig({
  testDir: "perf",
  outputDir: "../../.box-out/playwright-perf",
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "off" },
});
