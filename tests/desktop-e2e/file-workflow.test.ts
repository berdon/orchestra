import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getDomSnapshot,
  invokeCommand,
  selectByLabel,
  selectValue,
  setInputValue,
  sleep,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;
const targetFile = "/tmp/file.md";
const targetContents = "desktop-e2e-ok\n";

describe("desktop file workflow", () => {
  it.skipIf(!isDesktopE2E)("dispatches a real agent workflow that creates /tmp/file.md and completes the task", async () => {
    if (existsSync(targetFile)) {
      rmSync(targetFile, { force: true });
    }

    const sessionId = await createWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const projectName = 'File Workflow Project';
      const repoPath = join(testHome!, 'workspace', 'file-workflow-repo');

      await clickByText(sessionId, 'button', 'Settings');
      await waitForText(sessionId, 'Projects');
      await sleep(500);
      await clickByText(sessionId, 'button', 'New project');
      await sleep(500);
      await setInputValue(sessionId, '[data-role="project-name"]', projectName);
      await setInputValue(sessionId, '[data-role="project-description"]', 'Real desktop file creation workflow test.');
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, projectName);

      await setInputValue(sessionId, '[data-role="repository-name"]', 'File Workflow Repo');
      await setInputValue(sessionId, '[data-role="repository-local-path"]', repoPath);
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', 'main');
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, 'File Workflow Repo');
      await selectByLabel(sessionId, '[data-role="project-switcher"]', projectName);
      await sleep(1_000);

      const agent = await invokeCommand<{ slug: string }>(sessionId, 'create_agent', {
        input: {
          name: 'File Builder',
          description: 'Creates a requested file and closes the task automatically.',
          systemPrompt: 'Follow the task instructions exactly. Create the requested file for real, then use Orchestra tools to mark the lane as success when finished.',
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: 'minimal',
          roleId: null,
          policyIds: ['policy-supervisor'],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ name: string }>(sessionId, 'create_workflow', {
        input: {
          name: 'File Creation Flow',
          description: 'Single agent lane that creates the target file and ends the task.',
          lanes: [
            {
              id: null,
              key: 'create-file',
              name: 'Create File',
              description: null,
              order: 0,
              assignedEntityType: 'agent',
              assignedEntityId: agent.slug,
              entryPromptTemplate: `Create the file ${targetFile} with exact contents ${JSON.stringify(targetContents)}. When the file exists with the exact contents, mark the lane as success.`,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'user_intervention',
              failureTargetLaneId: null,
            },
          ],
        },
      });

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'New task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Create /tmp/file.md');
      await setInputValue(sessionId, '[data-role="task-description"]', `Create ${targetFile} with exact contents ${JSON.stringify(targetContents)}.`);
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await selectByLabel(sessionId, '[data-role="task-workflow"]', workflow.name);
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Create /tmp/file.md');
      await clickSelector(sessionId, '[data-role="dispatch-task-lane"]');
      await sleep(1_000);

      const deadline = Date.now() + 180_000;
      let latestTask: any = null;
      while (Date.now() < deadline) {
        if (existsSync(targetFile)) {
          latestTask = await invokeCommand<any>(sessionId, 'list_tasks', { includeArchived: false, projectId: null });
          break;
        }
        await sleep(1_000);
      }

      if (!existsSync(targetFile)) {
        const logs = await invokeCommand<any[]>(sessionId, 'get_logs');
        const sessions = await invokeCommand<any[]>(sessionId, 'list_sessions');
        const dom = await getDomSnapshot(sessionId);
        console.log('file workflow logs', JSON.stringify(logs.slice(0, 40)));
        console.log('file workflow sessions', JSON.stringify(sessions.slice(0, 10)));
        console.log('file workflow page text', JSON.stringify(dom.text));
      }
      expect(existsSync(targetFile)).toBe(true);
      expect(readFileSync(targetFile, 'utf8')).toBe(targetContents);

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'File Builder main session');
    } finally {
      await deleteWebdriverSession(sessionId);
      rmSync(targetFile, { force: true });
    }
  }, 240_000);
});
