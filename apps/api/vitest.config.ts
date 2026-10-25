import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@gachipad/api",
    setupFiles: ["../../scripts/vitest-namespace.ts"],
  },
});
