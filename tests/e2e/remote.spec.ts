import { expect, test } from "@playwright/test";

test("remote settings panel enables remote access, creates pairing codes, and revokes devices", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.remote-status",
      JSON.stringify({
        settings: {
          enabled: false,
          useTailscale: false,
          bindHost: "0.0.0.0",
          port: 49500,
          baseUrl: null,
          websocketUrl: null,
          lanBaseUrl: null,
          webUrl: null,
          tailscaleUrl: null,
          tailscaleWebUrl: null,
          startedAt: null,
          lastError: null,
        },
        pairingCodes: [],
        devices: [
          {
            id: "remote-device-1",
            label: "iPhone",
            platform: "ios",
            createdAt: timestamp,
            updatedAt: timestamp,
            lastSeenAt: timestamp,
            revokedAt: null,
            pushTokenConfigured: false,
            activeClientCount: 1,
          },
        ],
        activeClients: [
          {
            clientId: "remote-client-1",
            clientKind: "remote_driver",
            deviceId: "remote-device-1",
            deviceLabel: "iPhone",
            activeProjectId: "orchestra",
            connectedAt: timestamp,
            lastSeenAt: timestamp,
            subscribedSessionCount: 1,
          },
        ],
      }),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Remote" }).click();

  await expect(page.getByText("Enable Orchestra's host-side remote API, expose the hosted browser app, generate pairing codes, and manage trusted remote devices.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Remote API host" })).toBeVisible();
  await page.locator('[data-role="remote-enabled"]').check();
  await page.locator('[data-role="save-remote-settings"]').click();
  await expect(page.locator('[data-role="remote-endpoint-local-api"]')).toContainText("http://127.0.0.1:49500");
  await expect(page.locator('[data-role="remote-endpoint-pairing"]')).toContainText("Pairing API URL");
  await expect(page.locator('[data-role="copy-remote-endpoint-pairing"]')).toBeVisible();

  await page.locator('[data-role="remote-detail-tab-pairing"]').click();
  await page.locator('[data-role="create-remote-pairing-code"]').click();
  await expect(page.locator('[data-role="latest-remote-pairing-code"]')).toBeVisible();
  await expect(page.locator('[data-role="remote-pairing-codes-table"]')).toBeVisible();

  await page.locator('[data-role="remote-detail-tab-devices"]').click();
  await expect(page.locator('[data-role="remote-devices-table"]')).toContainText("iPhone");
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator('[data-role="remote-devices-table"]')).toContainText("Revoked");

  await page.locator('[data-role="remote-detail-tab-clients"]').click();
  await expect(page.getByText("No active remote clients.")).toBeVisible();
});
