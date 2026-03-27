import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop workforce work filters", () => {
  it.skipIf(!isDesktopE2E)("shows queued, active, and completed work chips on role details and hides completed by default", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Work Filter Project",
          description: "Role work filter coverage.",
        },
      });

      const role = await invokeCommand<{ id: string; name: string }>(sessionId, "create_role", {
        input: {
          name: "Work Filter Role",
          description: "Role for filter chip testing.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });

      await invokeCommand(sessionId, "enqueue_role_work", {
        input: {
          roleId: role.id,
          sourceType: "manual",
          title: "Completed work item",
          summary: "Should appear in completed filter.",
          entryPrompt: "completed",
        },
      });
      await invokeCommand(sessionId, "enqueue_role_work", {
        input: {
          roleId: role.id,
          sourceType: "manual",
          title: "Active work item",
          summary: "Should appear in active filter.",
          entryPrompt: "active",
        },
      });
      await invokeCommand(sessionId, "enqueue_role_work", {
        input: {
          roleId: role.id,
          sourceType: "manual",
          title: "Queued work item",
          summary: "Should appear in queued filter.",
          entryPrompt: "queued",
        },
      });

      let detail = await invokeCommand<any>(sessionId, "dispatch_role_queue", { roleId: role.id });
      expect(detail.instances).toHaveLength(1);
      detail = await invokeCommand<any>(sessionId, "release_role_instance", { instanceId: detail.instances[0].id, outcome: "success", errorMessage: null });
      expect(detail.instances.length).toBeGreaterThan(0);

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(500);

      await clickByText(sessionId, "button", "Agents");
      await waitForText(sessionId, "Roles in operation");
      await clickByText(sessionId, "a", role.name);

      await waitForText(sessionId, "Queued");
      await waitForText(sessionId, "Active");
      await waitForText(sessionId, "Completed");

      await waitForText(sessionId, "Active work item");
      const defaultHidesCompleted = await executeScript<boolean>(sessionId, `
        return !(document.body ? document.body.innerText : '').includes('Completed work item');
      `);
      expect(defaultHidesCompleted).toBe(true);

      await clickByText(sessionId, 'button', 'Queued');
      await waitForText(sessionId, 'Queued work item');

      await clickByText(sessionId, 'button', 'Completed');
      await waitForText(sessionId, 'Completed work item');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
