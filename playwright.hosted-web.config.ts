import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ORCHESTRA_HOSTED_WEB_E2E_PORT ?? 4175);
const baseURL = process.env.ORCHESTRA_HOSTED_WEB_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/hosted-web-e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "./scripts/run-hosted-web-e2e.sh",
    url: baseURL,
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
