import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";
import { orchestraProjectRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop project and workflow setup", () => {
  it.skipIf(!isDesktopE2E)("creates a project, repository, roles, and a workflow through the real desktop UI", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, 'Project catalog');
      await sleep(500);
      await clickByText(sessionId, "button", "New project");
      await sleep(500);
      await setInputValue(sessionId, '[data-role="project-name"]', "Desktop Automation Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Real desktop automation test project.");
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, "Desktop Automation Project");
      await waitForSelector(sessionId, '[data-role="repository-name"]');

      const repoPath = join(testHome!, "workspace", "desktop-automation-repo");
      const managedRepoPath = join(orchestraProjectRoot(testHome!, "desktop-automation-project"), "repositories", "desktop-automation-repo", "repository");
      await setFieldByLabel(sessionId, 'Repository name', 'Desktop Automation Repo');
      await setFieldByLabel(sessionId, 'Repository Path', repoPath);
      await setFieldByLabel(sessionId, 'Default branch', 'main');
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, 'Desktop Automation Repo');

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Desktop Automation Project");
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', "Desktop Automation Project");
      await sleep(500);

      await clickByText(sessionId, '[role="tab"]', "Roles");

      for (const roleName of ["Architect", "Developer", "QA"]) {
        await clickSelector(sessionId, '[data-role="new-role"]');
        await setInputValue(sessionId, '[data-role="role-name"]', roleName);
        await setFieldByLabel(sessionId, "Capacity", "1");
        await clickSelector(sessionId, '[data-role="save-role"]');
        await waitForText(sessionId, roleName);
      }

      await invokeCommand(sessionId, 'create_workflow', {
        input: {
          name: 'Development Automation',
          description: 'Workflow created during desktop project setup coverage.',
          lanes: [
            {
              id: 'lane-plan',
              key: 'plan',
              name: 'Plan',
              order: 0,
              assignedEntityType: 'role',
              assignedEntityId: 'architect',
              entryPromptTemplate: 'Plan the task.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: 'lane',
              successTargetLaneId: 'lane-implement',
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
            {
              id: 'lane-implement',
              key: 'implement',
              name: 'Implement',
              order: 1,
              assignedEntityType: 'role',
              assignedEntityId: 'developer',
              entryPromptTemplate: 'Implement the task.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: 'lane',
              successTargetLaneId: 'lane-validate',
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
            {
              id: 'lane-validate',
              key: 'validate',
              name: 'Validate',
              order: 2,
              assignedEntityType: 'role',
              assignedEntityId: 'qa',
              entryPromptTemplate: 'Validate the task.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: 'lane',
              successTargetLaneId: 'lane-user-review',
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
            {
              id: 'lane-user-review',
              key: 'user-review',
              name: 'User Review',
              order: 3,
              assignedEntityType: 'user',
              assignedEntityId: null,
              entryPromptTemplate: 'Review the result.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      await executeScript(sessionId, `window.location.reload(); return true;`);
      await sleep(1_000);
      await ensureReactReady(sessionId);
      await clickByText(sessionId, 'button', 'Settings');
      await clickByText(sessionId, '[role="tab"]', 'Workflows');
      await waitForText(sessionId, 'Development Automation');
      await waitForText(sessionId, 'User Review');

      const projects = await invokeCommand<Array<{ name: string; id: string }>>(sessionId, 'list_projects');
      const createdProject = projects.find((project) => project.name === 'Desktop Automation Project');
      expect(createdProject).toBeTruthy();

      const projectDetail = await invokeCommand<{ repositories: Array<{ name: string; repositoryPath: string | null }> }>(
        sessionId,
        'get_project',
        { projectId: createdProject!.id },
      );
      expect(projectDetail.repositories.some((repo) => repo.name === 'Desktop Automation Repo' && repo.repositoryPath === managedRepoPath)).toBe(true);

      const roles = await invokeCommand<Array<{ name: string; slug: string }>>(sessionId, 'list_roles', { includeArchived: false });
      expect(roles.map((role) => role.slug)).toEqual(expect.arrayContaining(['architect', 'developer', 'qa']));

      const workflows = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false });
      const workflow = workflows.find((entry) => entry.name === 'Development Automation');
      expect(workflow).toBeTruthy();

      const workflowDetail = await invokeCommand<{ lanes: Array<{ name: string; assignedEntityType: string; assignedEntityId: string | null }> }>(
        sessionId,
        'get_workflow',
        { workflowId: workflow!.id },
      );
      expect(workflowDetail.lanes.map((lane) => ({
        name: lane.name,
        assignedEntityType: lane.assignedEntityType,
        assignedEntityId: lane.assignedEntityId,
      }))).toEqual([
        { name: 'Plan', assignedEntityType: 'role', assignedEntityId: 'architect' },
        { name: 'Implement', assignedEntityType: 'role', assignedEntityId: 'developer' },
        { name: 'Validate', assignedEntityType: 'role', assignedEntityId: 'qa' },
        { name: 'User Review', assignedEntityType: 'user', assignedEntityId: null },
      ]);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("deletes a project through project settings UI and removes its Orchestra storage", async () => {
    expect(testHome).toBeTruthy();

    const projectRoot = orchestraProjectRoot(testHome!, "delete-me-project");
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "Project catalog");
      await sleep(500);
      await clickByText(sessionId, "button", "New project");
      await sleep(500);
      await setInputValue(sessionId, '[data-role="project-name"]', "Delete Me Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Project deletion regression test.");
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, 'Delete Me Project');

      const createdProjects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      expect(createdProjects.some((project) => project.name === 'Delete Me Project')).toBe(true);
      expect(existsSync(projectRoot)).toBe(true);

      await clickSelector(sessionId, '[data-role="delete-project"]');
      await waitForText(sessionId, 'Confirm delete');
      await clickSelector(sessionId, '[data-role="delete-project"]');
      await waitForText(sessionId, 'Orchestra');

      const remainingProjects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      expect(remainingProjects.some((project) => project.name === 'Delete Me Project')).toBe(false);
      expect(existsSync(projectRoot)).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
