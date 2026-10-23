import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/api",
    setupFiles: ["../../scripts/vitest-namespace.ts"],
  },
});
