import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/collab",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files start servers and child processes; run them one at a time.
    fileParallelism: false,
    setupFiles: ["../../scripts/vitest-namespace.ts"],
  },
});
