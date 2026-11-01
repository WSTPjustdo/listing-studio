import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: {
    baseURL: "http://127.0.0.1:18799",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Edge"],
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  },
  webServer: {
    command: "node tests/e2e-server.mjs",
    url: "http://127.0.0.1:18799/api/health",
    timeout: 15000,
    reuseExistingServer: false,
  },
});
