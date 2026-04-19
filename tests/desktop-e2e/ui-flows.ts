import {
  clickByText,
  clickNthSelector,
  clickSelector,
  executeScript,
  invokeCommand,
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

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

export async function createProjectViaSettings(sessionId: string, name: string, description: string) {
  await clickByText(sessionId, "button", "Settings");
  await waitForText(sessionId, "Project catalog");
  await clickByText(sessionId, "button", "New project");
  await waitForText(sessionId, "New project");
  await waitForSelector(sessionId, '[data-role="project-name"]');
  await setInputValue(sessionId, '[data-role="project-name"]', name);
  await setInputValue(sessionId, '[data-role="project-description"]', description);
  await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
  await waitForText(sessionId, name);
  await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: name });
}

export async function addRepositoryViaSettings(
  sessionId: string,
  options: { name: string; path: string; defaultBranch?: string; makeDefault?: boolean },
) {
  await waitForSelector(sessionId, '[data-role="repository-name"]');
  await setFieldByLabel(sessionId, 'Repository name', options.name);
  await setFieldByLabel(sessionId, 'Repository Path', options.path);
  await setFieldByLabel(sessionId, 'Default branch', options.defaultBranch ?? 'main');
  await clickSelector(sessionId, '[data-role="add-repository"]');
  await waitForText(sessionId, options.name);
  if (options.makeDefault) {
    const selectedProjectName = await executeScript<string | null>(sessionId, `
      const heading = document.querySelector('.task-detail-panel h3, .task-detail-panel h2');
      return heading ? heading.textContent?.trim() ?? null : null;
    `);
    const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
    const selectedProject = projects.find((entry) => entry.name === selectedProjectName);
    const repositories = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', {
      projectId: selectedProject?.id,
    });
    const repository = repositories.find((entry) => entry.name === options.name);
    if (!selectedProject || !repository) {
      throw new Error(`Unable to resolve repository ${options.name} for default assignment`);
    }
    await invokeCommand(sessionId, 'set_project_default_repository', {
      projectId: selectedProject.id,
      repositoryId: repository.id,
    });
    await waitForText(sessionId, 'Default');
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

export async function createAgentViaSettings(
  sessionId: string,
  options: {
    name: string;
    description?: string;
    systemPrompt?: string;
    thinkingLevel?: string;
    provider?: string;
    model?: string;
    supervisor?: boolean;
    scope?: 'global' | 'project';
  },
) {
  const agentSlug = slugify(options.name);
  await clickByText(sessionId, '[role="tab"]', 'Agents');
  await clickSelector(sessionId, '[data-role="new-agent"]');
  await waitForText(sessionId, 'Create agent');
  await waitForSelector(sessionId, '[data-role="agent-name"]');
  await setInputValue(sessionId, '[data-role="agent-name"]', options.name);
  if (options.scope) {
    await selectValue(sessionId, '[data-role="agent-scope"]', options.scope);
  }
  if (options.provider) {
    await selectValue(sessionId, '[data-role="agent-provider"]', options.provider);
    if (options.model) {
      await waitForSelectOption(sessionId, '[data-role="agent-model"]', { value: options.model });
      await selectValue(sessionId, '[data-role="agent-model"]', options.model);
    }
  }
  if (options.thinkingLevel) {
    await selectValue(sessionId, '[data-role="agent-thinking"]', options.thinkingLevel);
  }
  if (options.description !== undefined) {
    await setFieldByLabel(sessionId, 'Description', options.description);
  }
  if (options.systemPrompt !== undefined) {
    await setFieldByLabel(sessionId, 'System prompt', options.systemPrompt);
  }
  void options.supervisor;
  await clickSelector(sessionId, '[data-role="save-agent"]');
  await waitForSelector(sessionId, `[data-role="agent-list-name-${agentSlug}"]`);
}

export async function createWorkflowViaSettings(
  sessionId: string,
  options: {
    name: string;
    description?: string;
    lanes: Array<{
      name: string;
      key: string;
      ownerType: 'user' | 'agent' | 'role';
      ownerReference?: string;
      entryPromptTemplate?: string;
      requireUserApprovalOnSuccess?: boolean;
      successTransitionType?: 'end' | 'lane' | 'user_intervention';
      successTargetLaneName?: string;
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
      await waitForSelectOption(sessionId, '[data-role="lane-owner-reference"]', { value: lane.ownerReference });
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', lane.ownerReference);
    }
    if (lane.entryPromptTemplate !== undefined) {
      await setFieldByLabel(sessionId, 'Entry prompt template', lane.entryPromptTemplate);
    }
    if (lane.useSeparateWorktree) {
      const toggled = await executeScript<boolean>(
        sessionId,
        `
          const input = document.querySelector('[data-role="lane-use-separate-worktree"]');
          if (!(input instanceof HTMLInputElement)) return false;
          if (!input.checked) input.click();
          return true;
        `,
      );
      if (!toggled) {
        throw new Error('Unable to enable separate worktree for lane');
      }
    }
    if (lane.requireUserApprovalOnSuccess) {
      const toggled = await executeScript<boolean>(
        sessionId,
        `
          const input = document.querySelector('[data-role="lane-success-review-required"]');
          if (!(input instanceof HTMLInputElement)) return false;
          if (!input.checked) input.click();
          return true;
        `,
      );
      if (!toggled) {
        throw new Error('Unable to enable require user approval on success');
      }
    }
    if (lane.successTransitionType && lane.successTransitionType !== 'end') {
      const changed = await executeScript<boolean>(
        sessionId,
        `
          const labels = Array.from(document.querySelectorAll('.field-group'));
          const group = labels.find((entry) => entry.textContent?.toLowerCase().includes('success transition'));
          const select = group?.querySelector('select');
          if (!(select instanceof HTMLSelectElement)) return false;
          select.value = arguments[0];
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        `,
        [lane.successTransitionType],
      );
      if (!changed) {
        throw new Error('Unable to update success transition type');
      }
      if (lane.successTransitionType === 'lane' && lane.successTargetLaneName) {
        await waitForSelectOption(sessionId, '[data-role="lane-success-target"]', { label: lane.successTargetLaneName }).catch(() => undefined);
      }
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
    whipMaxAttempts?: number;
    publish?: boolean;
  },
) {
  await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
  await clickSelector(sessionId, '[data-role="new-task"]');
  await waitForText(sessionId, 'New task');
  await setInputValue(sessionId, '[data-role="task-title"]', options.title);
  await setInputValue(sessionId, '[data-role="task-description"]', options.description);
  if (options.repositoryName) {
    await selectByLabel(sessionId, '[data-role="task-repositories"]', options.repositoryName);
  }
  if (options.workflowName) {
    await waitForSelectOption(sessionId, '[data-role="task-workflow"]', { label: options.workflowName });
    await selectByLabel(sessionId, '[data-role="task-workflow"]', options.workflowName);
  }
  if (options.whipMaxAttempts !== undefined) {
    await setInputValue(sessionId, '[data-role="task-whip-max-attempts"]', String(options.whipMaxAttempts));
  }
  await clickSelector(sessionId, options.publish ? '[data-role="publish-task"]' : '[data-role="save-task"]');
  await waitForText(sessionId, options.title);
}

export async function createScheduledTaskViaTasks(
  sessionId: string,
  options: {
    title: string;
    description: string;
    repositoryName?: string;
    workflowName?: string;
    enabled?: boolean;
    oneShot?: boolean;
    overlapPolicy?: "skip" | "create_another";
    trigger:
      | { type: "time"; kind: "once"; at: string; timezone?: string }
      | { type: "time"; kind: "everyMinutes"; everyMinutes: number }
      | { type: "time"; kind: "daily"; timeOfDay: string; timezone?: string }
      | { type: "event"; eventKey: string };
  },
) {
  await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
  const hasNewTaskSelector = await executeScript<boolean>(
    sessionId,
    `return Boolean(document.querySelector('[data-role="new-task"]'));`,
  );
  if (hasNewTaskSelector) {
    await clickSelector(sessionId, '[data-role="new-task"]');
  } else {
    await clickByText(sessionId, 'button', 'New task');
  }
  await waitForText(sessionId, 'New task');
  await clickSelector(sessionId, '[data-role="task-create-scheduled-toggle"]');
  await waitForText(sessionId, 'New scheduled task');
  await setInputValue(sessionId, '[data-role="task-title"]', options.title);
  await setInputValue(sessionId, '[data-role="task-description"]', options.description);
  if (options.repositoryName) {
    await selectByLabel(sessionId, '[data-role="task-repositories"]', options.repositoryName);
  }
  if (options.workflowName) {
    await waitForSelectOption(sessionId, '[data-role="task-workflow"]', { label: options.workflowName });
    await selectByLabel(sessionId, '[data-role="task-workflow"]', options.workflowName);
  }
  if (options.enabled === false) {
    await clickSelector(sessionId, '[data-role="task-schedule-enabled"]');
  }
  if (options.oneShot === true) {
    await clickSelector(sessionId, '[data-role="task-schedule-one-shot"]');
  }
  if (options.overlapPolicy) {
    await selectValue(sessionId, '[data-role="task-schedule-overlap-policy"]', options.overlapPolicy);
  }
  if (options.trigger.type === 'event') {
    await selectValue(sessionId, '[data-role="task-schedule-trigger-type"]', 'event');
    await setInputValue(sessionId, '[data-role="task-schedule-trigger-event-key"]', options.trigger.eventKey);
  } else {
    await selectValue(sessionId, '[data-role="task-schedule-trigger-type"]', 'time');
    await selectValue(sessionId, '[data-role="task-schedule-trigger-kind"]', options.trigger.kind);
    if (options.trigger.kind === 'once') {
      await setInputValue(sessionId, '[data-role="task-schedule-trigger-at"]', options.trigger.at);
      if (options.trigger.timezone) {
        await setInputValue(sessionId, '[data-role="task-schedule-trigger-timezone"]', options.trigger.timezone);
      }
    } else if (options.trigger.kind === 'everyMinutes') {
      await setInputValue(sessionId, '[data-role="task-schedule-trigger-every-minutes"]', String(options.trigger.everyMinutes));
    } else if (options.trigger.kind === 'daily') {
      await setInputValue(sessionId, '[data-role="task-schedule-trigger-time-of-day"]', options.trigger.timeOfDay);
      if (options.trigger.timezone) {
        await setInputValue(sessionId, '[data-role="task-schedule-trigger-timezone"]', options.trigger.timezone);
      }
    }
  }
  await clickSelector(sessionId, options.enabled === false ? '[data-role="save-task-schedule"]' : '[data-role="create-task-schedule"]');
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

export async function dispatchTaskViaUi(sessionId: string) {
  const selector = await executeScript<string | null>(
    sessionId,
    `
      if (document.querySelector('[data-role="dispatch-task-lane"]')) return '[data-role="dispatch-task-lane"]';
      if (document.querySelector('[data-role="publish-task"]')) return '[data-role="publish-task"]';
      return null;
    `,
  );
  if (selector) {
    await clickSelector(sessionId, selector);
    return;
  }
  await clickByText(sessionId, 'button', 'Dispatch');
}

export async function completeTaskSuccessViaUi(sessionId: string) {
  await clickSelector(sessionId, '[data-role="complete-task-success"]');
}

export async function openRoleOperations(sessionId: string, roleName: string) {
  await clickByText(sessionId, 'button', 'Agents');
  await waitForText(sessionId, 'Roles in operation');
  await clickByText(sessionId, 'a', roleName);
  await waitForText(sessionId, roleName);
}

export async function enqueueRoleWorkViaUi(
  sessionId: string,
  options: { title: string; summary: string; entryPrompt: string },
) {
  await setFieldByLabel(sessionId, 'Title', options.title);
  await setFieldByLabel(sessionId, 'Summary', options.summary);
  await setFieldByLabel(sessionId, 'Entry prompt', options.entryPrompt);
  await clickByText(sessionId, 'button', 'Enqueue work');
  await sleep(250);
}

export async function dispatchRoleQueueViaUi(sessionId: string) {
  await clickByText(sessionId, 'button', 'Dispatch queue');
}
