import { expect, type Page } from "@playwright/test";

export async function fetchHostedWebPairingCode(page: Page) {
  const response = await page.request.get("/__e2e/pairing-code");
  expect(response.ok()).toBe(true);
  const body = await response.json() as { code: string };
  expect(body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return body.code;
}

export async function pairHostedWebBrowser(page: Page) {
  const code = await fetchHostedWebPairingCode(page);
  const pairingResponse = await page.request.post("/api/v1/pair/complete", {
    data: {
      code,
      label: "Playwright Hosted Web",
      platform: "browser",
      pushToken: null,
    },
  });
  expect(pairingResponse.ok()).toBe(true);

  await page.goto("/");
  await expect(page.locator('[data-role="project-switcher"]')).toBeVisible();
}
