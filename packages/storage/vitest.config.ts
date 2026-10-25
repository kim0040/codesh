import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@gachipad/storage",
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
