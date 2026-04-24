import { expect, test } from "@playwright/test";

import { fetchHostedWebPairingCode } from "./helpers";

test("hosted-web browser auth gate pairs on the live server and reloads into the main shared app", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('[data-role="hosted-web-auth-gate"]')).toBeVisible();
  await expect(page.locator('[data-role="hosted-web-current-origin"]')).toContainText("http://127.0.0.1:4175");

  const bootstrapBefore = await page.request.get("/api/v1/frontend/bootstrap", {
    headers: {
      Accept: "application/json",
    },
  });
  expect(bootstrapBefore.ok()).toBe(true);
  const unauthenticatedBootstrap = await bootstrapBefore.json() as { authMode: string };
  expect(unauthenticatedBootstrap.authMode).toBe("none");

  const pairingCode = await fetchHostedWebPairingCode(page);
  await page.locator('[data-role="hosted-web-pairing-code"]').fill(pairingCode);
  await page.locator('[data-role="hosted-web-pair-submit"]').click();

  await expect(page.locator('[data-role="project-switcher"]')).toBeVisible();
  await expect(page.locator('[data-role="nav-item-tasks"]')).toBeVisible();
  await expect(page.locator("body")).toContainText("Tasks");
  await expect(page.locator("body")).not.toContainText("Paired web client (dev harness)");

  const bootstrapAfter = await page.request.get("/api/v1/frontend/bootstrap", {
    headers: {
      Accept: "application/json",
    },
  });
  expect(bootstrapAfter.ok()).toBe(true);
  const authenticatedBootstrap = await bootstrapAfter.json() as { authMode: string };
  expect(authenticatedBootstrap.authMode).toBe("same_origin_cookie");
});
