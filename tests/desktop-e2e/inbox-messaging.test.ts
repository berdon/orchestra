import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getDomSnapshot,
  invokeCommand,
  selectByLabel,
  setInputValue,
  sleep,
  waitForText,
} from "./driver";
import {
  createProjectViaSettings,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(1_000);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

describe("desktop inbox and messaging", () => {
  it.skipIf(!isDesktopE2E)("uses the desktop UI to send direct mail to an idle agent session and verifies the session handles it", async () => {
    const sessionId = await createReadyWebdriverSession();
    const directMailBody = "Desktop direct mail for idle agent.";

    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Agent Mail Handling Project", "Desktop direct-agent mail handling regression test.");
      await switchProject(sessionId, "Agent Mail Handling Project");

      await invokeCommand(sessionId, "create_agent", {
        input: {
          name: "Mail Handler Agent",
          description: "Deterministically handles direct unread mail in desktop E2E.",
          systemPrompt: [
            "You are a deterministic Orchestra agent.",
            "Whenever Orchestra tells you to check mail, immediately call get_unread_mail().",
            "If unread mail exists, read it carefully and then call mark_mail_read() for the visible unread deliveries.",
            "After you mark mail read, briefly confirm that you handled it.",
            "If there is no unread mail, respond with exactly 'No unread mail.'",
            "Do not ask questions.",
            "Do not use markdown.",
            "Do not use completion tools.",
          ].join(" "),
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          roleId: null,
          policyIds: ["policy-supervisor"],
          directPermissions: [],
        },
      });

      await clickByText(sessionId, "button", "Agents");
      await waitForText(sessionId, "Persistent collaborators");
      await waitForText(sessionId, "Mail Handler Agent", 60_000);
      await clickByText(sessionId, "a", "Mail Handler Agent");
      await waitForText(sessionId, "Agent runtime");
      await clickSelector(sessionId, '[data-role="open-agent-session"]');
      await waitForText(sessionId, "Mail Handler Agent main session", 60_000);

      await clickByText(sessionId, "button", "Inbox");
      await waitForText(sessionId, "User Inbox");
      await selectByLabel(sessionId, '[data-role="inbox-compose-agent"]', "Mail Handler Agent");
      await setInputValue(sessionId, '[data-role="inbox-compose-body"]', directMailBody);
      await clickSelector(sessionId, '[data-role="send-inbox-message"]');

      const handledSession = await waitForCondition(
        () => invokeCommand<any[]>(sessionId, "list_sessions", {}),
        (sessions) =>
          sessions.some(
            (entry) =>
              entry.title === "Mail Handler Agent main session"
              && Array.isArray(entry.events)
              && entry.events.some((event: any) => String(event.message ?? "").includes(directMailBody))
              && entry.events.some((event: any) => String(event.message ?? "").includes("mark_mail_read tool result")),
          ),
        180_000,
      ).then((sessions) =>
        sessions.find(
          (entry) =>
            entry.title === "Mail Handler Agent main session"
            && Array.isArray(entry.events)
            && entry.events.some((event: any) => String(event.message ?? "").includes(directMailBody))
            && entry.events.some((event: any) => String(event.message ?? "").includes("mark_mail_read tool result")),
        ),
      );

      expect(handledSession).toBeTruthy();
      expect(handledSession.events.some((event: any) => String(event.message ?? "").includes("get_unread_mail tool result"))).toBe(true);
      expect(handledSession.events.some((event: any) => String(event.message ?? "").includes(directMailBody))).toBe(true);
      expect(handledSession.events.some((event: any) => String(event.message ?? "").includes("readSessionId"))).toBe(true);

    } catch (error) {
      const dom = await getDomSnapshot(sessionId).catch(() => null);
      const logs = await invokeCommand<any[]>(sessionId, "get_logs").catch(() => []);
      const sessions = await invokeCommand<any[]>(sessionId, "list_sessions").catch(() => []);
      console.error("inbox messaging dom", dom?.text ?? "<unavailable>");
      console.error("inbox messaging logs", JSON.stringify(logs.slice(0, 50), null, 2));
      console.error("inbox messaging sessions", JSON.stringify(sessions, null, 2));
      throw error;
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 300_000);
});
