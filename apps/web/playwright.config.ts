import { defineConfig } from "@playwright/test";
import { API_PORT, BASE_URL, COLLAB_PORT, MONGO_URL, VALKEY_URL, WEB_PORT } from "./e2e/env";

const secret = "e2e-secret-e2e-secret-e2e-secret-0123";
const shared = { MONGO_URL, VALKEY_URL, COLLAB_SECRET: secret, NODE_ENV: "development" };

export default defineConfig({
  testDir: "e2e",
  outputDir: "../../.box-out/playwright",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 3,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: "pnpm exec tsx src/main.ts",
      cwd: "../api",
      url: `http://localhost:${API_PORT}/healthz`,
      env: {
        ...shared,
        PORT: String(API_PORT),
        SESSION_SECRET: secret,
        RATE_LIMIT_API_PER_MIN: "100000",
        RATE_LIMIT_CODE_PER_MIN: "100000",
        RATE_LIMIT_CREATE_PER_MIN: "100000",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm exec tsx src/main.ts",
      cwd: "../collab",
      // It only answers on /collab, so the listening port is the readiness signal.
      port: COLLAB_PORT,
      env: { ...shared, PORT: String(COLLAB_PORT), COLLAB_INSTANCE_ID: "e2e" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm exec vite",
      url: BASE_URL,
      env: {
        WEB_PORT: String(WEB_PORT),
        API_PORT: String(API_PORT),
        COLLAB_PORT: String(COLLAB_PORT),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
