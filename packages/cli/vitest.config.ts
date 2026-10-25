import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@gachipad/cli",
    setupFiles: ["../../scripts/vitest-namespace.ts"],
  },
});
