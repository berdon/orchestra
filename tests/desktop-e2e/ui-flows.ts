import {
  clickByText,
  clickNthSelector,
  clickSelector,
  selectByLabel,
  selectValue,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectOption,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

export async function createProjectViaSettings(sessionId: string, name: string, description: string) {
  await clickByText(sessionId, "button", "Settings");
  await waitForText(sessionId, "Project catalog");
  await clickByText(sessionId, "button", "New project");
  await waitForText(sessionId, "New project");
  await setInputValue(sessionId, '[data-role="project-name"]', name);
  await setInputValue(sessionId, '[data-role="project-description"]', description);
  await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
  await waitForText(sessionId, name);
}

export async function addRepositoryViaSettings(
  sessionId: string,
  options: { name: string; path: string; defaultBranch?: string; makeDefault?: boolean },
) {
  await waitForSelector(sessionId, '[data-role="repository-name"]');
  await setFieldByLabel(sessionId, "Repository name", options.name);
  await setFieldByLabel(sessionId, "Repository Path", options.path);
  await setFieldByLabel(sessionId, "Default branch", options.defaultBranch ?? "main");
  await clickSelector(sessionId, '[data-role="add-repository"]');
  await waitForText(sessionId, options.name);
  if (options.makeDefault) {
    await clickByText(sessionId, "button", "Make default");
    await waitForText(sessionId, "Default");
  }
}

export async function switchProject(sessionId: string, projectName: string) {
  await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: projectName });
  await selectByLabel(sessionId, '[data-role="project-switcher"]', projectName);
  await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', projectName);
  await sleep(500);
}

export async function createRoleViaSettings(
  sessionId: string,
  options: { name: string; capacity?: string; description?: string; systemPrompt?: string; supervisor?: boolean },
) {
  await clickByText(sessionId, '[role="tab"]', 'Roles');
  await clickSelector(sessionId, '[data-role="new-role"]');
  await setInputValue(sessionId, '[data-role="role-name"]', options.name);
  if (options.capacity) {
    await setFieldByLabel(sessionId, 'Capacity', options.capacity);
  }
  if (options.description !== undefined) {
    await setFieldByLabel(sessionId, 'Description', options.description);
  }
  if (options.systemPrompt !== undefined) {
    await setFieldByLabel(sessionId, 'System prompt', options.systemPrompt);
  }
  if (options.supervisor) {
    await clickSelector(sessionId, '[data-role="role-supervisor-toggle"]');
  }
  await clickSelector(sessionId, '[data-role="save-role"]');
  await waitForText(sessionId, options.name);
}

export async function createWorkflowViaSettings(
  sessionId: string,
  options: {
    name: string;
    description?: string;
    lanes: Array<{
      name: string;
      key: string;
      ownerType: "user" | "agent" | "role";
      ownerReference?: string;
      entryPromptTemplate?: string;
    }>;
  },
) {
  await clickByText(sessionId, '[role="tab"]', 'Workflows');
  await clickByText(sessionId, 'button', 'New workflow');
  await setFieldByLabel(sessionId, 'Workflow name', options.name);
  if (options.description !== undefined) {
    await setFieldByLabel(sessionId, 'Description', options.description);
  }

  for (const [index, lane] of options.lanes.entries()) {
    if (index > 0) {
      await clickByText(sessionId, 'button', 'Add lane');
      await clickNthSelector(sessionId, '.workflow-board-lane', index);
    }
    await setFieldByLabel(sessionId, 'Lane name', lane.name);
    await setFieldByLabel(sessionId, 'Lane key', lane.key);
    await selectValue(sessionId, '[data-role="lane-owner-type"]', lane.ownerType);
    if (lane.ownerType !== 'user' && lane.ownerReference) {
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', lane.ownerReference);
    }
    if (lane.entryPromptTemplate !== undefined) {
      await setFieldByLabel(sessionId, 'Entry prompt template', lane.entryPromptTemplate);
    }
  }

  await clickSelector(sessionId, '[data-role="save-workflow"]');
  await waitForText(sessionId, options.name);
}

export async function createTaskViaTasks(
  sessionId: string,
  options: {
    title: string;
    description: string;
    repositoryName?: string;
    workflowName?: string;
  },
) {
  await clickByText(sessionId, 'button', 'Tasks');
  await clickSelector(sessionId, '[data-role="new-task"]');
  await waitForText(sessionId, 'New task');
  await setInputValue(sessionId, '[data-role="task-title"]', options.title);
  await setInputValue(sessionId, '[data-role="task-description"]', options.description);
  if (options.repositoryName) {
    await selectByLabel(sessionId, '[data-role="task-repositories"]', options.repositoryName);
  }
  if (options.workflowName) {
    await selectByLabel(sessionId, '[data-role="task-workflow"]', options.workflowName);
  }
  await clickSelector(sessionId, '[data-role="save-task"]');
  await waitForText(sessionId, options.title);
}

export async function openTaskCard(sessionId: string, title: string) {
  await clickByText(sessionId, 'button', 'Tasks');
  await waitForText(sessionId, title);
  await clickByText(sessionId, '[data-role="task-card"]', title);
  await waitForText(sessionId, title);
}

export async function addTaskCommentViaUi(sessionId: string, author: string, message: string) {
  await clickByText(sessionId, '[role="tab"]', 'Comments');
  await waitForText(sessionId, 'Task conversation');
  await setInputValue(sessionId, '[data-role="task-comment-author"]', author);
  await setInputValue(sessionId, '[data-role="task-comment-message"]', message);
  await clickSelector(sessionId, '[data-role="add-task-comment"]');
  await waitForText(sessionId, message);
}

export async function addTaskFileReferenceViaUi(
  sessionId: string,
  repositoryName: string,
  relativePath: string,
  makeDefault = false,
) {
  await clickByText(sessionId, '[role="tab"]', 'Repo files');
  await waitForText(sessionId, 'Tracked repository file changes and references');
  await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', repositoryName);
  await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', repositoryName);
  await setInputValue(sessionId, '[data-role="task-file-reference-path"]', relativePath);
  await clickSelector(sessionId, '[data-role="add-task-file-reference"]');
  await waitForText(sessionId, `${repositoryName} · ${relativePath}`);
  if (makeDefault) {
    await clickByText(sessionId, 'button', 'Set as default');
    await waitForText(sessionId, 'Default');
  }
}
