import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/storage",
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
