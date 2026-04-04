import { describe, expect, it } from "vitest";

import { clickByText, createReadyWebdriverSession, deleteWebdriverSession, ensureReactReady, executeScript, waitForText } from "./driver";
import { createProjectViaSettings, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop scoped agents", () => {
  it.skipIf(!isDesktopE2E)("keeps the supervisor global and visible across project switches", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Client Scoped Project", "Desktop scoped-agent regression project.");

      await clickByText(sessionId, "button", "Agents");
      await clickByText(sessionId, "button", "Refresh");
      await waitForText(sessionId, "Supervisor");

      await switchProject(sessionId, "Orchestra");
      await clickByText(sessionId, "button", "Agents");
      await clickByText(sessionId, "button", "Refresh");
      await waitForText(sessionId, "Supervisor");

      await switchProject(sessionId, "Client Scoped Project");
      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', 'Agents');
      await waitForText(sessionId, "Supervisor");
      const supervisorScopeLocked = await executeScript<boolean>(sessionId, `
        const supervisor = Array.from(document.querySelectorAll('a')).find((entry) => entry.textContent?.includes('Supervisor'));
        if (supervisor instanceof HTMLElement) supervisor.click();
        const scope = document.querySelector('[data-role="agent-scope"]');
        const badge = document.querySelector('[data-role="agent-scope-badge"]');
        return scope instanceof HTMLSelectElement
          ? scope.disabled && scope.value === 'global' && (badge?.textContent || '').includes('Global')
          : false;
      `);
      expect(supervisorScopeLocked).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
