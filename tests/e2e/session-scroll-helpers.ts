import { expect, type Locator, type Page } from "@playwright/test";

export function buildMockSessionEvents(count: number, messagePrefix = "Transcript event") {
  const baseTime = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index}`,
    kind: index % 2 === 0 ? "assistant" : "user",
    message: `${messagePrefix} ${index}\n${"chat ".repeat(32)}`,
    timestamp: new Date(baseTime + index * 1000).toISOString(),
  }));
}

export async function expectTranscriptAutoScrollOn(transcript: Locator, toggle: Locator) {
  await transcript.waitFor();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "on");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "true");
  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.scrollHeight <= metrics.clientHeight || metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);
}

export async function expectTranscriptNotAtBottom(transcript: Locator) {
  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight < metrics.scrollHeight - 24;
    })
  ).toBe(true);
}

export async function scrollTranscriptUp(transcript: Locator, offset = 160) {
  await transcript.evaluate((node, distance) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - distance);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, offset);
}

export async function appendMockSessionEvent(page: Page, sessionId: string, message: string, reason = "test.session_scroll_entry") {
  await page.evaluate(({ nextSessionId, nextMessage, nextReason }) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextTimestamp = new Date().toISOString();
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== nextSessionId) {
        return session;
      }
      return {
        ...session,
        updatedAt: nextTimestamp,
        events: [
          ...session.events,
          {
            id: `event-${nextSessionId}-${session.events.length}`,
            kind: "assistant",
            message: nextMessage,
            timestamp: nextTimestamp,
          },
        ],
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: [nextSessionId],
        reason: nextReason,
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, {
    nextSessionId: sessionId,
    nextMessage: message,
    nextReason: reason,
  });
}
