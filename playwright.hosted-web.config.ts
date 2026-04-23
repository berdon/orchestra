import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/hosted-web-e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "on-first-retry",
  },
  webServer: {
    command: "./scripts/run-hosted-web-e2e.sh",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
