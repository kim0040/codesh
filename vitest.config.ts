import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/api", "apps/collab", "apps/web", "scripts/load"],
    passWithNoTests: true,
  },
});
