import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForEnabledSelector,
  waitForSelector,
  waitForText,
} from "./driver";
import { switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

type SessionRecordLike = {
  id: string;
  title?: string;
  status?: string;
  listVisibility?: string | null;
  messageability?: "messageable" | "closed" | null;
};

async function getSelectedSessionId(webdriverSessionId: string): Promise<string> {
  const result = await executeScript<string>(
    webdriverSessionId,
    `return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';`,
  );
  return result || "";
}

async function getAgentOperation(
  webdriverSessionId: string,
  agentSlug = "supervisor",
  projectId?: string,
) {
  const operations = await invokeCommand<Array<{
    agent: { id: string; name: string; slug: string };
    runtimeState: {
      status: string;
      mainSessionId: string | null;
      runtimeCwd: string | null;
      currentQueueEntryId: string | null;
      lastDispatchAt: string | null;
      lastError: string | null;
      terminalAttached: boolean;
      createdAt: string;
      updatedAt: string;
    };
  }>>(webdriverSessionId, "list_agent_operations", {
    ...(projectId ? { projectId } : {}),
  });
  return operations.find((op) => op.agent.slug === agentSlug) ?? null;
}

async function getAgentMainSessionId(
  webdriverSessionId: string,
  agentSlug = "supervisor",
  projectId?: string,
): Promise<string | null> {
  return (await getAgentOperation(webdriverSessionId, agentSlug, projectId))?.runtimeState.mainSessionId ?? null;
}

async function getAgentOperationsDetail(
  webdriverSessionId: string,
  agentId: string,
  projectId?: string,
) {
  return invokeCommand<{
    runtimeState: {
      status: string;
      mainSessionId: string | null;
      currentQueueEntryId: string | null;
    };
    queueEntries: Array<{
      id: string;
      status: string;
      sourceType: string;
      sourceTaskId: string | null;
    }>;
  }>(webdriverSessionId, "get_agent_operations", {
    agentId,
    ...(projectId ? { projectId } : {}),
  });
}

async function getComposerState(webdriverSessionId: string) {
  return executeScript<{
    composerDisabled: boolean;
    sendDisabled: boolean;
    messageabilityClosed: boolean;
    terminalReadonly: boolean;
  }>(
    webdriverSessionId,
    `
      const composer = document.querySelector('[data-role="composer-input"]');
      const send = document.querySelector('[data-role="send-message"]');
      return {
        composerDisabled: composer instanceof HTMLTextAreaElement ? composer.disabled : true,
        sendDisabled: send instanceof HTMLButtonElement ? send.disabled : true,
        messageabilityClosed: Boolean(document.querySelector('[data-role="session-messageability-closed"]')),
        terminalReadonly: Boolean(document.querySelector('[data-role="session-terminal-readonly"]')),
      };
    `,
  );
}

async function startAgentChatUnavailableErrorCapture(webdriverSessionId: string) {
  await executeScript(
    webdriverSessionId,
    `
      window.__orchestraTestAgentChatUnavailableErrors = [];
      window.__orchestraTestAgentChatUnavailableObserver?.disconnect?.();
      const capture = () => {
        const text = document.querySelector('[data-role="agent-chat-status-error"]')?.textContent || '';
        if (text.includes('This session is no longer available.')) {
          window.__orchestraTestAgentChatUnavailableErrors.push({ text, timestamp: Date.now() });
        }
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      window.__orchestraTestAgentChatUnavailableObserver = observer;
      capture();
      return true;
    `,
  );
}

async function expectNoAgentChatUnavailableError(webdriverSessionId: string) {
  const matches = await executeScript<Array<{ text: string; timestamp: number }>>(
    webdriverSessionId,
    `return window.__orchestraTestAgentChatUnavailableErrors || [];`,
  );
  expect(matches).toHaveLength(0);
}

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

describe("desktop chat session recovery", () => {
  it.skipIf(!isDesktopE2E)(
    "new session becomes the agent's main session after creation",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        // Open supervisor chat to ensure it has a session
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await waitForText(webdriverSessionId, "Supervisor chat");
        await startAgentChatUnavailableErrorCapture(webdriverSessionId);

        const initialSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value.length > 0),
          45_000,
          500,
          "supervisor chat session to become selected",
        );

        // Verify the agent's main session ID points to the initial session
        const mainBefore = await getAgentMainSessionId(webdriverSessionId);
        expect(mainBefore).toBe(initialSessionId);

        // Click "New Session" to create a new session
        await clickSelector(webdriverSessionId, '[data-role="session-actions-trigger"]');
        await sleep(300);
        await waitForSelector(webdriverSessionId, '[data-role="session-action-new"]');
        await clickSelector(webdriverSessionId, '[data-role="session-action-new"]');

        // Wait for a different session to be selected
        const newSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== initialSessionId),
          45_000,
          500,
          "new chat session to replace the old one after New session",
        );

        // Verify the agent's main session ID has been updated to the new session
        const mainAfter = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId),
          (value) => value === newSessionId,
          30_000,
          500,
          "agent mainSessionId to be updated to the new session",
        );
        expect(mainAfter).toBe(newSessionId);
        expect(mainAfter).not.toBe(initialSessionId);
        await expectNoAgentChatUnavailableError(webdriverSessionId);

        // The replacement should hide the superseded session from normal lists while
        // keeping it directly inspectable for history/audit purposes.
        const sessionsAfter = await invokeCommand<Array<SessionRecordLike>>(
          webdriverSessionId,
          "list_sessions",
        );
        expect(sessionsAfter.some((s) => s.id === initialSessionId)).toBe(false);
        expect(sessionsAfter.some((s) => s.id === newSessionId)).toBe(true);

        const supersededRecord = await invokeCommand<SessionRecordLike>(
          webdriverSessionId,
          "get_session_record",
          { sessionId: initialSessionId },
        );
        expect(supersededRecord.id).toBe(initialSessionId);
        expect(supersededRecord.status).toBe("closed");
        expect(supersededRecord.listVisibility).toBe("hidden");
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "recreates a missing agent main session without showing the unavailable banner",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await waitForText(webdriverSessionId, "Supervisor chat");
        await startAgentChatUnavailableErrorCapture(webdriverSessionId);

        const initialSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value.length > 0),
          45_000,
          500,
          "initial supervisor chat session to become selected",
        );
        await setInputValue(
          webdriverSessionId,
          '[data-role="composer-input"]',
          'Keep this draft during recovery',
        );

        const agentOperation = await getAgentOperation(webdriverSessionId, "supervisor");
        expect(agentOperation?.agent.id).toBeTruthy();
        await invokeCommand(webdriverSessionId, "update_agent_main_session", {
          agentId: agentOperation!.agent.id,
          mainSessionId: `missing-session-${Date.now()}`,
        });

        await clickByText(webdriverSessionId, "button", "Sessions");
        await waitForSelector(webdriverSessionId, '[data-role="session-filter-active"]');
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForText(webdriverSessionId, "Supervisor chat");

        const recoveredSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== initialSessionId),
          45_000,
          500,
          "replacement supervisor chat session to become selected",
        );
        const recoveredMainSessionId = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId),
          (value) => value === recoveredSessionId,
          30_000,
          500,
          "supervisor main session id to update to the replacement session",
        );

        expect(recoveredMainSessionId).toBe(recoveredSessionId);
        await waitForSelector(webdriverSessionId, '[data-role="composer-input"]');
        const composerValue = await executeScript<string>(
          webdriverSessionId,
          `
            const element = document.querySelector('[data-role="composer-input"]');
            return element instanceof HTMLTextAreaElement ? element.value : '';
          `,
        );
        expect(composerValue).toBe('Keep this draft during recovery');
        await expectNoAgentChatUnavailableError(webdriverSessionId);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "after navigating away and back, the new session remains selected",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        // Open supervisor chat
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await waitForText(webdriverSessionId, "Supervisor chat");
        await startAgentChatUnavailableErrorCapture(webdriverSessionId);

        const sessionBeforeNew = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value.length > 0),
          45_000,
          500,
          "supervisor chat session to become selected",
        );

        // Click "New Session" to create a new session
        await clickSelector(webdriverSessionId, '[data-role="session-actions-trigger"]');
        await sleep(300);
        await waitForSelector(webdriverSessionId, '[data-role="session-action-new"]');
        await clickSelector(webdriverSessionId, '[data-role="session-action-new"]');

        const newSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== sessionBeforeNew),
          45_000,
          500,
          "new chat session to replace the old one after New session",
        );

        // Verify the agent's main session ID matches the new session
        const mainSessionId = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId),
          (value) => value === newSessionId,
          30_000,
          500,
          "agent mainSessionId to match the new session",
        );
        expect(mainSessionId).toBe(newSessionId);

        // Navigate away to Tasks
        await clickByText(webdriverSessionId, "button", "Tasks");
        await sleep(500);

        // Navigate back to Chat
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]', 15_000);
        await sleep(500);

        // CRITICAL: Verify the new session (not the old one) is still selected
        const sessionAfterRecovery = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== sessionBeforeNew),
          60_000,
          500,
          "chat session to remain the new session after navigating away and back",
        );

        expect(sessionAfterRecovery).not.toBe(
          sessionBeforeNew,
          "Chat should show the new session, not the old one that was replaced",
        );
        expect(sessionAfterRecovery).toBe(
          newSessionId,
          `Chat should match the session created by "New session" (${newSessionId})`,
        );

        // Also verify the agent's mainSessionId still points to the new session
        const mainAfterRecovery = await getAgentMainSessionId(webdriverSessionId);
        expect(mainAfterRecovery).toBe(newSessionId);
        await expectNoAgentChatUnavailableError(webdriverSessionId);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "dispatching work to an agent reuses its single chat session and keeps it busy",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        const runToken = Date.now().toString(36);
        const projectName = `Agent Chat Dispatch ${runToken}`;
        const project = await invokeCommand<{ id: string; name: string; slug: string }>(webdriverSessionId, "create_project", {
          input: {
            name: projectName,
            taskPrefix: "ACD",
            description: "Regression test for keeping dispatched agent work on the same direct chat session.",
          },
        });
        await switchProject(webdriverSessionId, projectName);

        const agent = await invokeCommand<{ id: string; slug: string; name: string }>(webdriverSessionId, "create_agent", {
          input: {
            name: `Dispatch Isolation Agent ${runToken}`,
            description: "Project-scoped agent used to verify dispatch keeps using the same direct chat session.",
            systemPrompt: [
              "You are a deterministic Orchestra agent.",
              "If task work is dispatched to you, reply with a short acknowledgement only.",
              "Do not ask questions.",
              "Do not call any Orchestra tools unless the prompt explicitly requires it.",
            ].join(" "),
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            thinkingLevel: "off",
            scope: "project",
            projectId: project.id,
            policyIds: ["policy-supervisor"],
          },
        });

        await executeScript(webdriverSessionId, `window.location.reload(); return true;`);
        await sleep(1_000);
        await ensureReactReady(webdriverSessionId);
        await switchProject(webdriverSessionId, projectName);

        await clickSelector(webdriverSessionId, '[data-role="nav-item-chat"]');
        await waitForSelector(webdriverSessionId, `[data-role="chat-agent-nav-${agent.slug}"]`);
        await clickSelector(webdriverSessionId, `[data-role="chat-agent-nav-${agent.slug}"]`);
        await waitForText(webdriverSessionId, `${agent.name} chat`);

        const directChatSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value),
          45_000,
          500,
          "direct agent chat session to become selected",
        );
        expect(directChatSessionId).toBeTruthy();

        const initialMainSessionId = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId, agent.slug, project.id),
          (value) => value === directChatSessionId,
          30_000,
          500,
          "agent main session to point at the direct chat session before dispatch",
        );
        expect(initialMainSessionId).toBe(directChatSessionId);

        const initialComposer = await getComposerState(webdriverSessionId);
        expect(initialComposer.composerDisabled).toBe(false);
        expect(initialComposer.sendDisabled).toBe(false);
        expect(initialComposer.messageabilityClosed).toBe(false);
        expect(initialComposer.terminalReadonly).toBe(false);

        const workflow = await invokeCommand<{ id: string }>(webdriverSessionId, "create_workflow", {
          input: {
            name: `Dispatch Isolation Workflow ${runToken}`,
            description: "Dispatches work to the same agent using its single chat session.",
            lanes: [
              {
                id: "lane-agent-dispatch",
                key: "agent-dispatch",
                name: "Agent Dispatch",
                order: 0,
                assignedEntityType: "agent",
                assignedEntityId: agent.slug,
                entryPromptTemplate: `Reply with a short acknowledgement containing DISPATCH-${runToken} and nothing else.`,
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
            title: `Dispatch isolation task ${runToken}`,
            description: "Verifies that dispatch reuses the direct chat session.",
            type: "task",
            status: "ready",
            priority: "P2",
            workflowId: workflow.id,
            currentLaneId: "lane-agent-dispatch",
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });

        const dispatchedTask = await waitForCondition(
          async () => {
            let task = await invokeCommand<any>(webdriverSessionId, "get_task", { taskId: createdTask.id });
            if (!task.activeLaneAssignment?.sessionId) {
              await invokeCommand(webdriverSessionId, "dispatch_task_lane", { taskId: createdTask.id }).catch(() => undefined);
              await invokeCommand(webdriverSessionId, "run_dispatcher_tick").catch(() => undefined);
              task = await invokeCommand<any>(webdriverSessionId, "get_task", { taskId: createdTask.id });
            }
            return task;
          },
          (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.workerType === "agent",
          90_000,
          1_000,
          "agent task dispatch to reuse the existing chat session",
        );

        const taskSessionId = dispatchedTask.activeLaneAssignment.sessionId as string;
        expect(taskSessionId).toBeTruthy();
        expect(taskSessionId).toBe(directChatSessionId);
        expect(dispatchedTask.activeLaneAssignment.status).toBe("active");

        const directRecordAfterDispatch = await waitForCondition(
          () => invokeCommand<SessionRecordLike>(webdriverSessionId, "get_session_record", { sessionId: directChatSessionId }),
          (record) => record.id === directChatSessionId && record.status !== "closed" && record.messageability === "messageable",
          60_000,
          500,
          "direct agent chat session to remain open and messageable while dispatch runs",
        );
        expect(directRecordAfterDispatch.status).not.toBe("closed");
        expect(directRecordAfterDispatch.messageability).toBe("messageable");

        const mainSessionAfterDispatch = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId, agent.slug, project.id),
          (value) => value === directChatSessionId,
          30_000,
          500,
          "agent main session to stay pointed at the direct chat session after dispatch",
        );
        expect(mainSessionAfterDispatch).toBe(directChatSessionId);

        expect(await getSelectedSessionId(webdriverSessionId)).toBe(directChatSessionId);

        const composerAfterDispatch = await getComposerState(webdriverSessionId);
        expect(composerAfterDispatch.messageabilityClosed).toBe(false);
        expect(composerAfterDispatch.terminalReadonly).toBe(false);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "queues pending task dispatch while an agent chat session is busy, then starts it once free",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        const runToken = Date.now().toString(36);
        const projectName = `Agent Busy Queue ${runToken}`;
        const project = await invokeCommand<{ id: string; name: string; slug: string }>(webdriverSessionId, "create_project", {
          input: {
            name: projectName,
            taskPrefix: "ABQ",
            description: "Regression test for queueing task dispatch while an agent chat is busy.",
          },
        });
        await switchProject(webdriverSessionId, projectName);

        const agent = await invokeCommand<{ id: string; slug: string; name: string }>(webdriverSessionId, "create_agent", {
          input: {
            name: `Busy Queue Agent ${runToken}`,
            description: "Project-scoped agent used to verify queued dispatch while its direct chat is busy.",
            systemPrompt: [
              "You are a deterministic Orchestra agent.",
              "When dispatched task work arrives, reply with a short acknowledgement only.",
              "Do not ask questions.",
              "Do not call any Orchestra tools unless the prompt explicitly requires it.",
            ].join(" "),
            provider: "openai-codex",
            model: "gpt-5.3-codex-spark",
            thinkingLevel: "off",
            scope: "project",
            projectId: project.id,
            policyIds: ["policy-supervisor"],
          },
        });

        await executeScript(webdriverSessionId, `window.location.reload(); return true;`);
        await sleep(1_000);
        await ensureReactReady(webdriverSessionId);
        await switchProject(webdriverSessionId, projectName);

        await clickSelector(webdriverSessionId, '[data-role="nav-item-chat"]');
        await waitForSelector(webdriverSessionId, `[data-role="chat-agent-nav-${agent.slug}"]`);
        await clickSelector(webdriverSessionId, `[data-role="chat-agent-nav-${agent.slug}"]`);
        await waitForText(webdriverSessionId, `${agent.name} chat`);
        await waitForEnabledSelector(webdriverSessionId, '[data-role="composer-input"]');

        const directChatSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value),
          45_000,
          500,
          "direct agent chat session to become selected",
        );
        expect(directChatSessionId).toBeTruthy();

        const busyPrompt = [
          "Use the bash tool exactly once and wait for it to finish.",
          "Run exactly this command:",
          `\`\`\`bash\nsleep 8 && printf \"agent-busy-queue-${runToken}\"\n\`\`\``,
          `After the tool completes, reply with exactly agent-busy-queue-${runToken}.`,
        ].join("\n\n");

        await setInputValue(webdriverSessionId, '[data-role="composer-input"]', busyPrompt);
        await waitForEnabledSelector(webdriverSessionId, '[data-role="send-message"]');
        await clickSelector(webdriverSessionId, '[data-role="send-message"]');
        await waitForText(webdriverSessionId, 'Use the bash tool exactly once');

        await waitForCondition(
          () => executeScript<{ disabled: boolean }>(webdriverSessionId, `
            const button = document.querySelector('[data-role="stop-session-runtime"]');
            return { disabled: !(button instanceof HTMLButtonElement) || button.disabled };
          `),
          (value) => value.disabled === false,
          30_000,
          500,
          "busy direct agent run to expose a stop button",
        );

        const workflow = await invokeCommand<{ id: string }>(webdriverSessionId, "create_workflow", {
          input: {
            name: `Busy Queue Workflow ${runToken}`,
            description: "Queues task dispatch until the busy direct agent chat becomes free.",
            lanes: [
              {
                id: "lane-agent-busy-queue",
                key: "agent-busy-queue",
                name: "Agent Busy Queue",
                order: 0,
                assignedEntityType: "agent",
                assignedEntityId: agent.slug,
                entryPromptTemplate: `Reply with a short acknowledgement containing BUSY-QUEUE-${runToken} and nothing else.`,
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
            title: `Busy queue task ${runToken}`,
            description: "Verifies queued task dispatch while the agent chat session is already busy.",
            type: "task",
            status: "ready",
            priority: "P2",
            workflowId: workflow.id,
            currentLaneId: "lane-agent-busy-queue",
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });

        await invokeCommand(webdriverSessionId, "dispatch_task_lane", { taskId: createdTask.id });

        const queuedTask = await waitForCondition(
          () => invokeCommand<any>(webdriverSessionId, "get_task", { taskId: createdTask.id }),
          (task) => task.activeLaneAssignment?.status === "queued" && !task.activeLaneAssignment?.sessionId,
          30_000,
          500,
          "busy agent task dispatch to remain queued until the chat session is free",
        );
        expect(queuedTask.activeLaneAssignment.status).toBe("queued");
        expect(queuedTask.activeLaneAssignment.sessionId ?? null).toBeNull();

        const queuedAgentOps = await waitForCondition(
          () => getAgentOperationsDetail(webdriverSessionId, agent.id, project.id),
          (detail) => detail.queueEntries.some(
            (entry) => entry.sourceType === "workflow_lane"
              && entry.sourceTaskId === createdTask.id
              && entry.status === "queued",
          ),
          30_000,
          500,
          "agent workflow queue entry to stay queued while direct chat is busy",
        );
        expect(queuedAgentOps.runtimeState.mainSessionId).toBe(directChatSessionId);
        expect(queuedAgentOps.queueEntries.some(
          (entry) => entry.sourceType === "workflow_lane"
            && entry.sourceTaskId === createdTask.id
            && entry.status === "queued",
        )).toBe(true);

        await clickSelector(webdriverSessionId, '[data-role="stop-session-runtime"]');

        const resumedTask = await waitForCondition(
          async () => {
            await invokeCommand(webdriverSessionId, "run_dispatcher_tick").catch(() => undefined);
            return invokeCommand<any>(webdriverSessionId, "get_task", { taskId: createdTask.id });
          },
          (task) => (
            task.activeLaneAssignment?.status === "active"
            && task.activeLaneAssignment?.sessionId === directChatSessionId
          ) || (
            task.status === "completed"
            && Array.isArray(task.laneSummaries)
            && task.laneSummaries.some((summary: any) =>
              summary.laneId === "lane-agent-busy-queue"
              && summary.sessionId === directChatSessionId
              && summary.outcome === "success"
            )
          ),
          60_000,
          1_000,
          "queued agent task dispatch to run on the same chat session once it becomes free",
        );
        if (resumedTask.activeLaneAssignment) {
          expect(resumedTask.activeLaneAssignment.sessionId).toBe(directChatSessionId);
        } else {
          expect(resumedTask.status).toBe("completed");
          expect(resumedTask.laneSummaries.some((summary: any) =>
            summary.laneId === "lane-agent-busy-queue"
            && summary.sessionId === directChatSessionId
            && summary.outcome === "success"
          )).toBe(true);
        }

        expect(await getSelectedSessionId(webdriverSessionId)).toBe(directChatSessionId);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );
});
