import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectValue,
  setWindowRect,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const MOBILE_WINDOW = { width: 390, height: 844 };
const agentName = "Mobile Save Regression Agent";

async function openSettingsAgents(sessionId: string, agentId: string) {
  await clickSelector(sessionId, '[data-role="toggle-mobile-navigation"]');
  await waitForSelector(sessionId, '[data-role="mobile-navigation-sheet"]');
  await clickByText(sessionId, '[data-role="mobile-navigation-sheet"] button', 'Settings');
  await waitForSelector(sessionId, '[data-role="settings-sections-subnav"]');
  await clickSelector(sessionId, '[data-role="settings-tab-agents"]');
  await waitForSelector(sessionId, '[data-role="agent-mobile-subnav-shell"]');
  await selectValue(sessionId, '[data-role="agent-mobile-subnav-select-control"]', agentId);
  await waitForText(sessionId, agentName);
}

async function saveAgentFromMobileMenu(sessionId: string) {
  await clickSelector(sessionId, '[data-role="agent-mobile-subnav-menu-trigger"]');
  await clickByText(sessionId, '.task-action-menu__dropdown button', 'Save changes');
}

async function reloadAndReopenAgents(sessionId: string, agentId: string) {
  await executeScript(sessionId, 'window.location.reload(); return true;');
  await sleep(1_000);
  await ensureReactReady(sessionId);
  await setWindowRect(sessionId, MOBILE_WINDOW);
  await openSettingsAgents(sessionId, agentId);
}

async function readStoredAgent(sessionId: string, agentId: string) {
  return invokeCommand<{
    directPermissions?: string[];
    thinkingLevel?: string | null;
  }>(sessionId, 'get_agent', { agentId }).then((agent) => ({
    directPermissions: agent.directPermissions ?? [],
    thinkingLevel: agent.thinkingLevel ?? null,
  }));
}

describe("desktop agent settings mobile save", () => {
  it.skipIf(!isDesktopE2E)("persists agent access and configuration changes saved from the mobile action menu", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const createdAgent = await invokeCommand<{ id: string }>(sessionId, 'create_agent', {
        input: {
          name: agentName,
          thinkingLevel: 'medium',
          scope: 'global',
          policyIds: [],
          directPermissions: [],
        },
      });
      await executeScript(sessionId, 'window.location.reload(); return true;');
      await sleep(1_000);
      await ensureReactReady(sessionId);

      await clickByText(sessionId, 'button', 'Settings');
      await clickByText(sessionId, '[role="tab"]', 'Agents');
      await waitForText(sessionId, agentName);

      await setWindowRect(sessionId, MOBILE_WINDOW);
      await waitForSelector(sessionId, '[data-role="agent-mobile-subnav-shell"]');
      await selectValue(sessionId, '[data-role="agent-mobile-subnav-select-control"]', createdAgent.id);
      await waitForText(sessionId, agentName);

      await clickSelector(sessionId, '[data-role="agent-detail-tab-access"]');
      await clickSelector(sessionId, '[data-role="agent-permission-roles.dispatch"]');
      await expect.poll(async () => executeScript(sessionId, `
        const input = document.querySelector('[data-role="agent-permission-roles.dispatch"]');
        return input instanceof HTMLInputElement ? input.checked : null;
      `)).toBe(true);
      await saveAgentFromMobileMenu(sessionId);

      await expect.poll(async () => readStoredAgent(sessionId, createdAgent.id), { timeout: 10_000 }).toMatchObject({
        directPermissions: ['roles.dispatch'],
        thinkingLevel: 'medium',
      });

      await reloadAndReopenAgents(sessionId, createdAgent.id);
      await clickSelector(sessionId, '[data-role="agent-detail-tab-access"]');
      await expect.poll(async () => executeScript(sessionId, `
        const input = document.querySelector('[data-role="agent-permission-roles.dispatch"]');
        return input instanceof HTMLInputElement ? input.checked : null;
      `)).toBe(true);

      await clickSelector(sessionId, '[data-role="agent-detail-tab-configuration"]');
      await selectValue(sessionId, '[data-role="agent-thinking"]', 'high');
      await saveAgentFromMobileMenu(sessionId);

      await expect.poll(async () => readStoredAgent(sessionId, createdAgent.id), { timeout: 10_000 }).toMatchObject({
        directPermissions: ['roles.dispatch'],
        thinkingLevel: 'high',
      });

      await reloadAndReopenAgents(sessionId, createdAgent.id);
      await clickSelector(sessionId, '[data-role="agent-detail-tab-configuration"]');
      await expect.poll(async () => executeScript(sessionId, `
        const select = document.querySelector('[data-role="agent-thinking"]');
        return select instanceof HTMLSelectElement ? select.value : null;
      `)).toBe('high');
    } finally {
      await deleteWebdriverSession(sessionId);
      await sleep(250);
    }
  }, 180_000);
});
