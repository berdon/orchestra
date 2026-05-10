import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setWindowRect,
  typeIntoInput,
  waitForSelector,
  waitForText,
} from "./driver";
import { createProjectViaSettings, createTaskViaTasks, openTaskCard, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function resetInputPerfStats(sessionId: string) {
  return executeScript<{ renderCounts: Record<string, number> }>(
    sessionId,
    `return window.__orchestraResetInputPerfStats ? window.__orchestraResetInputPerfStats() : { renderCounts: {} };`,
  );
}

async function getInputPerfStats(sessionId: string) {
  return executeScript<{ renderCounts: Record<string, number> }>(
    sessionId,
    `return window.__orchestraTestInputPerfStats ? window.__orchestraTestInputPerfStats() : { renderCounts: {} };`,
  );
}

function renderCountDelta(
  before: { renderCounts: Record<string, number> },
  after: { renderCounts: Record<string, number> },
  key: string,
) {
  return (after.renderCounts[key] ?? 0) - (before.renderCounts[key] ?? 0);
}

async function injectSessionRecord(sessionId: string, record: Record<string, unknown>) {
  await executeScript(
    sessionId,
    `
      const apply = window.__orchestraTestApplySessionRecord;
      if (typeof apply !== 'function') {
        throw new Error('Missing __orchestraTestApplySessionRecord test hook');
      }
      apply(arguments[0]);
      return true;
    `,
    [record],
  );
}

describe("desktop typing performance regressions", () => {
  it.skipIf(!isDesktopE2E)("keeps session and task comment typing responsive under heavy history", async () => {
    const sessionId = await createReadyWebdriverSession();
    const suffix = Date.now().toString(36);
    const projectName = `Typing Perf ${suffix}`;
    const taskTitle = `Typing performance task ${suffix}`;
    const sessionTitle = `Typing perf session ${suffix}`;

    try {
      await ensureReactReady(sessionId);
      await setWindowRect(sessionId, { width: 1440, height: 1100 });

      await createProjectViaSettings(sessionId, projectName, "Regression coverage for sluggish typing in session and task comment composers.");
      await switchProject(sessionId, projectName);
      await createTaskViaTasks(sessionId, {
        title: taskTitle,
        description: "Seed a dense task comment thread and verify typing stays responsive.",
      });

      const project = await invokeCommand<Array<{ id: string; slug: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === projectName));
      expect(project).toBeTruthy();

      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === taskTitle));
      expect(task).toBeTruthy();

      for (let index = 0; index < 12; index += 1) {
        await invokeCommand(sessionId, "comment_on_task", {
          taskId: task!.id,
          input: {
            author: "Reviewer",
            message: `Seed comment ${index}\n\n- bullet one\n- bullet two\n\n\`inline-${index}\``,
            interruptAgent: false,
          },
        });
      }

      const createdSession = await invokeCommand<{ id: string; title: string }>(sessionId, "create_session", {
        title: sessionTitle,
        projectSlug: project!.slug,
      });
      const sessionRecord = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: createdSession.id }).catch(() => null);
      const now = new Date().toISOString();
      const events = Array.from({ length: 36 }, (_, index) => ({
        id: `typing-event-${index}`,
        kind: index % 2 === 0 ? "user" : "assistant",
        message: `Transcript entry ${index}\n\n- item ${index}\n- detail ${index + 1}`,
        timestamp: now,
      }));

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForSelector(sessionId, `[data-session-id="${createdSession.id}"]`);
      await clickSelector(sessionId, `[data-session-id="${createdSession.id}"]`);
      await waitForSelector(sessionId, '[data-role="composer-input"]');
      await injectSessionRecord(sessionId, {
        ...(sessionRecord ?? {}),
        id: createdSession.id,
        title: sessionTitle,
        status: "idle",
        createdAt: sessionRecord?.createdAt ?? now,
        updatedAt: now,
        subscribed: true,
        events,
      });
      await waitForText(sessionId, "Transcript entry 1");

      await resetInputPerfStats(sessionId);
      const sessionTyping = await typeIntoInput(
        sessionId,
        '[data-role="composer-input"]',
        'Responsive session typing\nwith multiline coverage.',
        { clear: true, delayMs: 5 },
      );
      const afterSessionTyping = await getInputPerfStats(sessionId);
      expect(sessionTyping.value).toBe('Responsive session typing\nwith multiline coverage.');
      expect(renderCountDelta({ renderCounts: {} }, afterSessionTyping, 'sessions-session-list')).toBeLessThanOrEqual(2);
      expect(sessionTyping.durationMs).toBeLessThanOrEqual(sessionTyping.charactersTyped * 45);

      await openTaskCard(sessionId, taskTitle);
      await waitForText(sessionId, "Seed comment 11");

      await resetInputPerfStats(sessionId);
      const topLevelCommentTyping = await typeIntoInput(
        sessionId,
        '[data-role="task-comment-message"]',
        'Responsive top-level comment typing.',
        { clear: true, delayMs: 5 },
      );
      const afterTopLevelCommentTyping = await getInputPerfStats(sessionId);
      expect(topLevelCommentTyping.value).toBe('Responsive top-level comment typing.');
      expect(renderCountDelta({ renderCounts: {} }, afterTopLevelCommentTyping, 'task-comment-message')).toBeLessThanOrEqual(20);
      expect(renderCountDelta({ renderCounts: {} }, afterTopLevelCommentTyping, 'default-file-viewer')).toBeLessThanOrEqual(1);
      expect(topLevelCommentTyping.durationMs).toBeLessThanOrEqual(topLevelCommentTyping.charactersTyped * 60);

      await clickSelector(sessionId, '[data-role="add-task-comment"]');
      await waitForText(sessionId, 'Responsive top-level comment typing.');

      await clickSelector(sessionId, '[data-role="reply-task-comment"]');
      await waitForSelector(sessionId, '[data-role="task-reply-message"]');
      await resetInputPerfStats(sessionId);
      const replyTyping = await typeIntoInput(
        sessionId,
        '[data-role="task-reply-message"]',
        'Responsive reply typing.',
        { clear: true, delayMs: 5 },
      );
      const afterReplyTyping = await getInputPerfStats(sessionId);
      expect(replyTyping.value).toBe('Responsive reply typing.');
      expect(renderCountDelta({ renderCounts: {} }, afterReplyTyping, 'task-comment-message')).toBeLessThanOrEqual(30);
      expect(replyTyping.durationMs).toBeLessThanOrEqual(replyTyping.charactersTyped * 80);

      await setWindowRect(sessionId, { width: 900, height: 1100 });
      await waitForSelector(sessionId, '[data-role="task-comment-message"]');
      await resetInputPerfStats(sessionId);
      const narrowCommentTyping = await typeIntoInput(
        sessionId,
        '[data-role="task-comment-message"]',
        'Narrow layout comment typing stays responsive.',
        { clear: true, delayMs: 5 },
      );
      const afterNarrowCommentTyping = await getInputPerfStats(sessionId);
      expect(narrowCommentTyping.value).toBe('Narrow layout comment typing stays responsive.');
      expect(renderCountDelta({ renderCounts: {} }, afterNarrowCommentTyping, 'task-comment-message')).toBeLessThanOrEqual(20);
      expect(narrowCommentTyping.durationMs).toBeLessThanOrEqual(narrowCommentTyping.charactersTyped * 80);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
