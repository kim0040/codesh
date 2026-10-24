import { defineConfig } from "@playwright/test";
import {
  ADMIN_TOKEN,
  API_PORT,
  BASE_URL,
  COLLAB_PORT,
  MONGO_URL,
  VALKEY_URL,
  WEB_PORT,
} from "./e2e/env";

/**
 * Chromium runs every spec. Firefox and WebKit run the cross-OS spec (shortcuts, labels, IME,
 * OS-dependent features), so a Mac or Linux visitor's engine is covered too, and the device spec.
 * They need `pnpm exec playwright install firefox webkit` once; `E2E_BROWSERS=chromium` skips them.
 */
const ENGINES = (process.env.E2E_BROWSERS ?? "chromium,firefox,webkit").split(",");
const CROSS_OS = /o-cross-os\.spec\.ts$/;
// Offline copies on Firefox and WebKit too: their IndexedDB differs (databases(), deletion while
// open, Safari's storage lifecycle).
const DEVICE = /r-edit-key-and-device\.spec\.ts$/;

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
  projects: [
    ...(ENGINES.includes("chromium")
      ? [{ name: "chromium", use: { browserName: "chromium" as const } }]
      : []),
    ...(ENGINES.includes("firefox")
      ? [
          {
            name: "firefox",
            use: { browserName: "firefox" as const },
            testMatch: [CROSS_OS, DEVICE],
          },
        ]
      : []),
    ...(ENGINES.includes("webkit")
      ? [
          {
            name: "webkit",
            use: { browserName: "webkit" as const },
            testMatch: [CROSS_OS, DEVICE],
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: "pnpm exec tsx src/main.ts",
      cwd: "../api",
      url: `http://localhost:${API_PORT}/healthz`,
      env: {
        ...shared,
        PORT: String(API_PORT),
        SESSION_SECRET: secret,
        ADMIN_TOKEN,
        RATE_LIMIT_API_PER_MIN: "100000",
        RATE_LIMIT_CODE_PER_MIN: "100000",
        RATE_LIMIT_CREATE_PER_MIN: "100000",
        // No outbound request from tests; p-updates.spec.ts mocks the update state instead.
        UPDATE_CHECK: "off",
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      command: "pnpm exec tsx src/main.ts",
      cwd: "../collab",
      // It only answers on /collab, so the listening port is the readiness signal.
      port: COLLAB_PORT,
      env: { ...shared, PORT: String(COLLAB_PORT), COLLAB_INSTANCE_ID: "e2e" },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
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
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
