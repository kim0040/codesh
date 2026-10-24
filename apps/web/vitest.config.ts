import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/web",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    // Playwright specs live in e2e/ and run with `pnpm test:e2e`.
    exclude: ["e2e/**", "node_modules/**"],
  },
});
