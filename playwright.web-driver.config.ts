import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.ORCHESTRA_WEB_DRIVER_E2E_PORT ?? 4174);
const baseURL = process.env.ORCHESTRA_WEB_DRIVER_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/web-driver-e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `bash -lc 'cd mobile && npm run web:build && cd dist-web && python3 -m http.server ${port} --bind 127.0.0.1'`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
