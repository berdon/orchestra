import { expect, test, type Page } from "@playwright/test";

type PiSetupSeed = {
  status: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  legacyAgentDir: string;
  availableProviders: Array<{
    id: string;
    name: string;
    authModes: string[];
    connected: boolean;
    usingOAuth: boolean;
    modelCount: number;
    usesCallbackServer: boolean;
    oauthMethods?: Array<{ id: string; label: string; kind: string; isDefault: boolean }> | null;
  }>;
  availableModels: Array<unknown>;
  issues: Array<unknown>;
  warnings: Array<unknown>;
  importState: {
    canImportLegacy: boolean;
    importedAt: string | null;
    dismissedAt: string | null;
  };
};

const defaultPiSetup: PiSetupSeed = {
  status: "ready",
  agentDir: "/mock/.orchestra/runtime/pi/agent",
  authPath: "/mock/.orchestra/runtime/pi/agent/auth.json",
  modelsPath: "/mock/.orchestra/runtime/pi/agent/models.json",
  legacyAgentDir: "/mock/.pi/agent",
  availableProviders: [
    {
      id: "anthropic",
      name: "Anthropic",
      authModes: ["api_key", "oauth"],
      connected: true,
      usingOAuth: false,
      modelCount: 1,
      usesCallbackServer: true,
      oauthMethods: [{ id: "browser_oauth", label: "Browser sign-in", kind: "browser", isDefault: true }],
    },
    {
      id: "openai-codex",
      name: "OpenAI Codex",
      authModes: ["oauth"],
      connected: false,
      usingOAuth: false,
      modelCount: 1,
      usesCallbackServer: true,
      oauthMethods: [{ id: "browser_oauth", label: "Browser sign-in", kind: "browser", isDefault: true }],
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      authModes: ["oauth"],
      connected: false,
      usingOAuth: false,
      modelCount: 1,
      usesCallbackServer: false,
      oauthMethods: [{ id: "device_code", label: "Device code auth", kind: "device_code", isDefault: true }],
    },
  ],
  availableModels: [],
  issues: [],
  warnings: [],
  importState: { canImportLegacy: false, importedAt: null, dismissedAt: null },
};

async function seedPiSetup(page: Page, setup: PiSetupSeed = defaultPiSetup) {
  await page.addInitScript((seed) => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.pi-setup", JSON.stringify(seed));
    window.localStorage.removeItem("orchestra.mock.pi-oauth-flow");
  }, setup);
}

async function openPiSettings(page: Page) {
  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("tab", { name: "Pi" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await expect(page.getByRole("heading", { name: "Orchestra-managed Pi auth and models" })).toBeVisible();
}

test("browser OAuth resolves cleanly, hides raw URLs, and reset clears the provider", async ({ page }) => {
  await seedPiSetup(page);
  await openPiSettings(page);

  const providerCard = page.locator('[data-role="pi-oauth-provider-openai-codex"]');
  await providerCard.locator('[data-role="pi-oauth-connect-openai-codex"]').click();

  await expect(providerCard.locator('[data-role="pi-oauth-link-openai-codex"]')).toHaveText("Open browser sign-in");
  await expect(providerCard).not.toContainText("Auth URL:");
  await expect(providerCard).not.toContainText("https://example.com/oauth/openai-codex");

  await expect(providerCard.getByRole("heading", { name: "Connected" })).toBeVisible({ timeout: 10_000 });
  await expect(providerCard.locator('[data-role="pi-oauth-flow-openai-codex"]')).toHaveCount(0);

  await providerCard.locator('[data-role="pi-oauth-reset-openai-codex"]').click();
  await expect(providerCard.getByRole("heading", { name: "Not connected" })).toBeVisible();
});

test("device-code providers show verification copy and unsupported providers do not show extra controls", async ({ page }) => {
  await seedPiSetup(page);
  await openPiSettings(page);

  const browserOnlyProvider = page.locator('[data-role="pi-oauth-provider-openai-codex"]');
  await expect(browserOnlyProvider.locator('[data-role="pi-oauth-connect-menu-openai-codex"]')).toHaveCount(0);

  const providerCard = page.locator('[data-role="pi-oauth-provider-github-copilot"]');
  await providerCard.locator('[data-role="pi-oauth-connect-github-copilot"]').click();
  await providerCard.locator('[data-role="pi-oauth-input-github-copilot"]').fill("company.ghe.com");
  await providerCard.getByRole("button", { name: "Continue" }).click();

  await expect(providerCard.locator('[data-role="pi-oauth-link-github-copilot"]')).toHaveText("Open verification page");
  await expect(providerCard.locator('[data-role="pi-oauth-user-code-github-copilot"]')).toContainText("Device code:");
  await expect(providerCard).toContainText("Enter the device code on the verification page.");
});

test("providers with multiple OAuth methods expose a split-button device-code option", async ({ page }) => {
  await seedPiSetup(page, {
    ...defaultPiSetup,
    availableProviders: [
      ...defaultPiSetup.availableProviders,
      {
        id: "example-dual",
        name: "Example Dual OAuth",
        authModes: ["oauth"],
        connected: false,
        usingOAuth: false,
        modelCount: 0,
        usesCallbackServer: true,
        oauthMethods: [
          { id: "browser_oauth", label: "Browser sign-in", kind: "browser", isDefault: true },
          { id: "device_code", label: "Device code auth", kind: "device_code", isDefault: false },
        ],
      },
    ],
  });
  await openPiSettings(page);

  const providerCard = page.locator('[data-role="pi-oauth-provider-example-dual"]');
  await providerCard.locator('[data-role="pi-oauth-connect-menu-example-dual"]').click();
  await providerCard.locator('[data-role="pi-oauth-connect-method-example-dual-device_code"]').click();

  await expect(providerCard.locator('[data-role="pi-oauth-link-example-dual"]')).toHaveText("Open verification page");
  await expect(providerCard.locator('[data-role="pi-oauth-user-code-example-dual"]')).toContainText("ABCD-EFGH");
  await expect(providerCard).toContainText("Enter the device code on the verification page.");
});
