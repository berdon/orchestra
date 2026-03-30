import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop agent queue deletion", () => {
  it.skipIf(!isDesktopE2E)("deletes queued work items from an agent queue through the real UI", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const agent = await invokeCommand<{ id: string; name: string }>(sessionId, "create_agent", {
        input: {
          name: "Queue Cleaner",
          description: "Agent used to verify queued work deletion.",
          thinkingLevel: "medium",
        },
      });
      expect(agent).toBeTruthy();

      const queued = await invokeCommand<{ id: string }>(sessionId, "enqueue_agent_work", {
        input: {
          agentId: agent!.id,
          sourceType: "manual",
          title: "Queued cleanup item",
          message: "Delete this queued work item.",
          deliveryMode: "follow_up",
        },
      });

      const queueBefore = await invokeCommand<{ queueEntries: Array<{ id: string; status: string }> }>(sessionId, "get_agent_operations", { agentId: agent!.id });
      expect(queueBefore.queueEntries.some((entry) => entry.id === queued.id && entry.status === "queued")).toBe(true);

      await clickByText(sessionId, "button", "Agents");
      await clickByText(sessionId, "a", "Queue Cleaner");
      await clickSelector(sessionId, '[data-role="agent-work-filter-queued"]');
      await waitForText(sessionId, "Queued cleanup item");
      await clickSelector(sessionId, '[data-role^="delete-agent-queue-entry-"]');
      await waitForText(sessionId, "No queued work right now.");

      const detail = await invokeCommand<{ queueEntries: Array<{ id: string }> }>(sessionId, "get_agent_operations", { agentId: agent!.id });
      expect(detail.queueEntries.some((entry) => entry.id)).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
