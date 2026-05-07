import { expect, test } from "@playwright/test";

import {
  buildExampleRemoteLanBaseUrl,
  buildExampleRemoteLanWebSocketUrl,
  buildExampleRemoteSecureBaseUrl,
} from "../../src/lib/exampleRemoteEndpoints";

const webDriverBaseUrl = process.env.ORCHESTRA_WEB_DRIVER_E2E_BASE_URL ?? "http://127.0.0.1:4174";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
});

test("paired web client dev harness shows pairing guidance and can reset the API host to the current page host", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Connect to Orchestra")).toBeVisible();
  await expect(page.getByTestId("web-driver-helper-card")).toBeVisible();
  await expect(page.getByTestId("web-driver-current-url")).toContainText(webDriverBaseUrl);
  await expect(page.getByTestId("web-driver-suggested-api-url")).toContainText("http://127.0.0.1:49500");

  const hostInput = page.getByTestId("connect-host-url");
  await expect(hostInput).toHaveValue("http://127.0.0.1:49500");
  await hostInput.fill("https://custom.example:49500");
  await page.getByTestId("web-driver-use-current-host").click();
  await expect(hostInput).toHaveValue("http://127.0.0.1:49500");
});

test("paired web client dev harness preserves the entered API URL after pairing on the web", async ({ page }) => {
  await page.route("**/api/v1/pair/complete", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "token-123",
        baseUrl: buildExampleRemoteLanBaseUrl(49500),
        websocketUrl: buildExampleRemoteLanWebSocketUrl(49500),
      }),
    });
  });

  await page.route("**/api/v1/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.goto("/");
  await page.getByTestId("connect-host-url").fill(buildExampleRemoteSecureBaseUrl(49500));
  await page.getByTestId("connect-pairing-code").fill("ABCD-EFGH");
  await page.getByTestId("connect-device-label").fill("Safari on iPhone");
  await page.getByTestId("connect-pair-device").click();

  await expect(page.getByText("Connect to Orchestra")).toHaveCount(0);

  const storedConnection = await page.evaluate(() => {
    const raw = window.localStorage.getItem("orchestra.mobile.connection");
    return raw ? JSON.parse(raw) : null;
  });

  expect(storedConnection).toMatchObject({
    baseUrl: buildExampleRemoteSecureBaseUrl(49500),
    token: "token-123",
    deviceLabel: "Safari on iPhone",
  });
});
