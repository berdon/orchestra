import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickNthSelector,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  selectByLabel,
  selectValue,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

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
      const managedRepoPath = join(testHome!, ".orchestra", "projects", "desktop-automation-project", "repositories", "desktop-automation-repo", "repository");
      await setInputValue(sessionId, '[data-role="repository-name"]', "Desktop Automation Repo");
      await setInputValue(sessionId, '[data-role="repository-path"]', repoPath);
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', "main");
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

      await clickByText(sessionId, '[role="tab"]', "Workflows");
      await clickByText(sessionId, 'button', 'New workflow');
      await setFieldByLabel(sessionId, 'Workflow name', 'Development Automation');
      await setFieldByLabel(sessionId, 'Lane name', 'Plan');
      await setFieldByLabel(sessionId, 'Lane key', 'plan');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'architect');

      await clickByText(sessionId, 'button', 'Add lane');
      await clickNthSelector(sessionId, '.workflow-board-lane', 1);
      await setFieldByLabel(sessionId, 'Lane name', 'Implement');
      await setFieldByLabel(sessionId, 'Lane key', 'implement');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'developer');

      await clickByText(sessionId, 'button', 'Add lane');
      await clickNthSelector(sessionId, '.workflow-board-lane', 2);
      await setFieldByLabel(sessionId, 'Lane name', 'Validate');
      await setFieldByLabel(sessionId, 'Lane key', 'validate');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'qa');

      await clickByText(sessionId, 'button', 'Add lane');
      await clickNthSelector(sessionId, '.workflow-board-lane', 3);
      await setFieldByLabel(sessionId, 'Lane name', 'User Review');
      await setFieldByLabel(sessionId, 'Lane key', 'user-review');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'user');

      await clickSelector(sessionId, '[data-role="save-workflow"]');
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
});
