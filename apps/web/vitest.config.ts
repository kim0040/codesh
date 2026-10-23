import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@codesh/web",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
