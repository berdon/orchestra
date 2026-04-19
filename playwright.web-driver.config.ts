import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/web-driver-e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry",
  },
  webServer: {
    command: "bash -lc 'cd mobile && npm run web:build && cd dist-web && python3 -m http.server 4174 --bind 127.0.0.1'",
    url: "http://127.0.0.1:4174",
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
