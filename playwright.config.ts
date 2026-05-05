import { defineConfig, devices } from "@playwright/test";

import { PLAYWRIGHT_WEB_HOST, PLAYWRIGHT_WEB_PORT, PLAYWRIGHT_WEB_URL } from "./tests/e2e/webServerConfig";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: PLAYWRIGHT_WEB_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run build && npm run preview -- --host ${PLAYWRIGHT_WEB_HOST} --port ${PLAYWRIGHT_WEB_PORT} --strictPort`,
    url: PLAYWRIGHT_WEB_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
