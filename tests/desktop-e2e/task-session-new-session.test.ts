import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForSelector,
} from "./driver";
import { switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

type SessionEventRecord = {
  kind?: string;
  message?: string | null;
};

function sessionHasEntryPromptEvent(
  record: Pick<SessionRecordLike, "events">,
  replyToken: string,
) {
  return (record.events ?? []).some(
    (event) => event.kind === "user" && (event.message ?? "").includes(replyToken),
  );
}

type SessionRecordLike = {
  id: string;
  title?: string;
  status?: string;
  listVisibility?: string | null;
  messageability?: string | null;
  events?: SessionEventRecord[];
};

type TaskDetailLike = {
  id: string;
  title?: string;
  status?: string;
  activeLaneAssignment?: {
    sessionId?: string | null;
    status?: string;
    workerType?: string | null;
  } | null;
};

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 500,
  label = "condition",
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(`${label} not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function getSelectedSessionUiState(webdriverSessionId: string) {
  return executeScript<{
    selectedSessionId: string;
    transcriptText: string;
    sessionListIds: string[];
  }>(
    webdriverSessionId,
    `
      return {
        selectedSessionId: document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '',
        transcriptText: document.querySelector('[data-role="session-transcript"]')?.textContent || '',
        sessionListIds: Array.from(document.querySelectorAll('[data-role="session-link"]')).map((entry) => entry.getAttribute('data-session-id') || '').filter(Boolean),
      };
    `,
  );
}

async function getTaskSessionDiagnostics(
  webdriverSessionId: string,
  taskId: string,
  oldSessionId?: string | null,
  newSessionId?: string | null,
) {
  const ui = await getSelectedSessionUiState(webdriverSessionId).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const task = await invokeCommand<TaskDetailLike>(webdriverSessionId, "get_task", { taskId }).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  const sessions = await invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions").catch((error) => ([{
    id: "list_sessions_error",
    title: error instanceof Error ? error.message : String(error),
  }]));
  const oldSession = oldSessionId
    ? await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: oldSessionId }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;
  const newSession = newSessionId
    ? await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: newSessionId }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;

  return {
    ui,
    task,
    oldSession,
    newSession,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      listVisibility: session.listVisibility,
      messageability: session.messageability,
      recentMessages: (session.events ?? []).slice(-3).map((event) => event.message ?? null),
    })),
  };
}

async function waitForConditionWithDiagnostics<T>(
  webdriverSessionId: string,
  taskId: string,
  oldSessionId: string | null | undefined,
  newSessionId: string | null | undefined,
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
  intervalMs = 500,
) {
  try {
    return await waitForCondition(callback, predicate, timeoutMs, intervalMs, label);
  } catch (error) {
    const diagnostics = await getTaskSessionDiagnostics(
      webdriverSessionId,
      taskId,
      oldSessionId,
      newSessionId,
    ).catch((diagnosticError) => ({
      error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
    }));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function clickSessionAction(webdriverSessionId: string, actionSelector: string) {
  await waitForCondition(
    () => executeScript<{ enabled: boolean }>(
      webdriverSessionId,
      `
        const trigger = document.querySelector('[data-role="session-actions-trigger"]');
        const existingMenu = document.querySelector('[data-role="session-actions-menu"]');
        if (!existingMenu && trigger instanceof HTMLElement) {
          trigger.click();
        }
        const action = document.querySelector(arguments[0]);
        return {
          enabled: action instanceof HTMLButtonElement && !action.disabled,
        };
      `,
      [actionSelector],
    ),
    (value) => value.enabled,
    30_000,
    250,
    `${actionSelector} to become enabled`,
  );
  await clickSelector(webdriverSessionId, actionSelector);
}

describe("desktop task session new-session handoff", () => {
  it.skipIf(!isDesktopE2E)("rotates task-associated sessions onto a fresh running successor and keeps the UI on the replacement", async () => {
    const webdriverSessionId = await createReadyWebdriverSession();

    try {
      await ensureReactReady(webdriverSessionId);

      const runToken = Date.now().toString(36);
      const replyToken = `TASK-NEW-SESSION-${runToken}`;
      const projectName = `Task Session Rotation ${runToken}`;
      const project = await invokeCommand<{ id: string; slug: string }>(webdriverSessionId, "create_project", {
        input: {
          name: projectName,
          taskPrefix: "TSR",
          description: "Regression coverage for task-associated New session handoff.",
        },
      });
      await switchProject(webdriverSessionId, projectName);

      const role = await invokeCommand<{ id: string; slug: string }>(webdriverSessionId, "create_role", {
        input: {
          name: `Task Session Role ${runToken}`,
          description: "Deterministic role used for task-session New session regression coverage.",
          systemPrompt: [
            "You are a deterministic Orchestra worker.",
            "Ignore any later instruction that asks you to use tools, leave comments, or transition the task.",
            "When the workflow prompt asks for a specific reply token, respond with exactly that token and nothing else.",
            "Do not ask questions.",
            "Never call tools.",
            "Never request user intervention.",
          ].join(" "),
          capacity: 1,
        },
      });

      const workflow = await invokeCommand<{ id: string }>(webdriverSessionId, "create_workflow", {
        input: {
          name: `Task Session Workflow ${runToken}`,
          description: "Single role-owned lane for task-session New session regression coverage.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: `Reply with exactly ${replyToken} and nothing else. Do not use tools. Do not transition the task.`,
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const createdTask = await invokeCommand<{ id: string }>(webdriverSessionId, "create_task", {
        projectId: project.id,
        input: {
          title: `Task session rotation ${runToken}`,
          description: "Verify task session New session handoff semantics.",
          type: "bug",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: "lane-implement",
          assigneeType: "unassigned",
          assigneeId: null,
          whipMaxAttempts: 100,
        },
      });

      const activeTask = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        null,
        null,
        async () => {
          let task = await invokeCommand<TaskDetailLike>(webdriverSessionId, "get_task", { taskId: createdTask.id });
          if (!task.activeLaneAssignment?.sessionId) {
            await invokeCommand(webdriverSessionId, "dispatch_task_lane", { taskId: createdTask.id }).catch(() => undefined);
            await invokeCommand(webdriverSessionId, "run_dispatcher_tick").catch(() => undefined);
            await invokeCommand(webdriverSessionId, "dispatch_role_queue", { roleId: role.id }).catch(() => undefined);
            task = await invokeCommand<TaskDetailLike>(webdriverSessionId, "get_task", { taskId: createdTask.id });
          }
          return task;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === "active",
        "task dispatch to create an active task-associated worker session",
        90_000,
        1_000,
      );

      const originalSessionId = activeTask.activeLaneAssignment?.sessionId as string;
      expect(originalSessionId).toBeTruthy();

      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        null,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: originalSessionId }),
        (record) => sessionHasEntryPromptEvent(record, replyToken),
        "initial task worker session to start immediately and receive its entry prompt",
        30_000,
        200,
      );

      await clickByText(webdriverSessionId, "button", "Sessions");
      await waitForSelector(webdriverSessionId, `[data-role="session-link"][data-session-id="${originalSessionId}"]`);
      await clickSelector(webdriverSessionId, `[data-role="session-link"][data-session-id="${originalSessionId}"]`);

      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        null,
        () => getSelectedSessionUiState(webdriverSessionId),
        (value) => value.selectedSessionId === originalSessionId,
        "original task session to be selected before clicking New session",
      );

      await clickSessionAction(webdriverSessionId, '[data-role="session-action-new"]');

      const successorSessionId = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        null,
        () => getSelectedSessionUiState(webdriverSessionId),
        (value) => Boolean(value.selectedSessionId) && value.selectedSessionId !== originalSessionId,
        "successor task session to replace the selected predecessor after New session",
      ).then((state) => state.selectedSessionId);

      expect(successorSessionId).toBeTruthy();
      expect(successorSessionId).not.toBe(originalSessionId);

      await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        successorSessionId,
        async () => ({
          ui: await getSelectedSessionUiState(webdriverSessionId),
          record: await invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: successorSessionId }),
        }),
        (value) => value.ui.selectedSessionId === successorSessionId
          && (value.ui.transcriptText.includes(replyToken) || sessionHasEntryPromptEvent(value.record, replyToken)),
        "replacement task session to start immediately and surface its initial prompt/response",
        30_000,
        200,
      );

      await executeScript(
        webdriverSessionId,
        `
          for (let index = 0; index < 5; index += 1) {
            window.dispatchEvent(new CustomEvent("orchestra:session-change", {
              detail: { sessionIds: [arguments[0]], reason: "task-new-session-refresh-" + index },
            }));
          }
          return true;
        `,
        [originalSessionId],
      );

      const taskAfterRotation = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        successorSessionId,
        () => invokeCommand<TaskDetailLike>(webdriverSessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.activeLaneAssignment?.sessionId === successorSessionId && task.activeLaneAssignment?.status === "active",
        "task assignment to point at the replacement session",
        20_000,
        100,
      );
      expect(taskAfterRotation.activeLaneAssignment?.sessionId).toBe(successorSessionId);

      const sessionsAfterRotation = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        successorSessionId,
        () => invokeCommand<Array<SessionRecordLike>>(webdriverSessionId, "list_sessions"),
        (sessions) => {
          const original = sessions.find((session) => session.id === originalSessionId);
          const successor = sessions.find((session) => session.id === successorSessionId);
          return Boolean(successor)
            && original?.status === "closed"
            && original?.listVisibility === "closed";
        },
        "session records to show the successor while retaining the superseded task session as closed history",
        45_000,
      );
      expect(sessionsAfterRotation.some((session) => session.id === successorSessionId)).toBe(true);
      expect(
        sessionsAfterRotation.find((session) => session.id === originalSessionId),
      ).toMatchObject({
        id: originalSessionId,
        status: "closed",
        listVisibility: "closed",
        messageability: "closed",
      });

      const supersededRecord = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        successorSessionId,
        () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: originalSessionId }),
        (record) => record.status === "closed" && record.listVisibility === "closed",
        "superseded task session to close while remaining visible as closed task history",
        45_000,
      );
      expect(supersededRecord.status).toBe("closed");
      expect(supersededRecord.listVisibility).toBe("closed");
      expect(supersededRecord.messageability).toBe("closed");

      const finalUiState = await waitForConditionWithDiagnostics(
        webdriverSessionId,
        createdTask.id,
        originalSessionId,
        successorSessionId,
        () => getSelectedSessionUiState(webdriverSessionId),
        (value) => value.selectedSessionId === successorSessionId
          && value.transcriptText.includes(replyToken)
          && !value.sessionListIds.includes(originalSessionId),
        "sessions UI to stay focused on the replacement task session",
        45_000,
      );
      expect(finalUiState.selectedSessionId).toBe(successorSessionId);
      expect(finalUiState.transcriptText).toContain(replyToken);
      expect(finalUiState.sessionListIds).not.toContain(originalSessionId);
    } finally {
      await deleteWebdriverSession(webdriverSessionId);
    }
  }, 300_000);
});
