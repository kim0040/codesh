import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/cli",
    setupFiles: ["../../scripts/vitest-namespace.ts"],
  },
});
