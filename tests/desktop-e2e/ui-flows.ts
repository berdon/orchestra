import {
  clickByText,
  clickNthSelector,
  clickSelector,
  dispatchWindowEvent,
  ensureReactReady,
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

function taskPrefixFromName(value: string) {
  const initials = value
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  const normalized = initials || value.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return (normalized || "PRJ").slice(0, 3).padEnd(3, "X");
}

export async function createProjectViaSettings(sessionId: string, name: string, description: string) {
  await clickByText(sessionId, "button", "Settings");
  await waitForText(sessionId, "Project catalog");
  await invokeCommand(sessionId, 'create_project', {
    input: {
      name,
      description,
      taskPrefix: taskPrefixFromName(name),
    },
  });
  await switchProject(sessionId, name);
  await clickByText(sessionId, 'button', 'Settings');
  await waitForText(sessionId, name);
}

export async function addRepositoryViaSettings(
  sessionId: string,
  options: { name: string; path: string; defaultBranch?: string; makeDefault?: boolean },
) {
  const selectedProject = await executeScript<{ value: string; label: string }>(sessionId, `
    const select = document.querySelector('[data-role="project-switcher"]');
    const triggerLabel = document.querySelector('[data-role="project-switcher-trigger"] .project-switcher__trigger-label');
    return {
      value: select instanceof HTMLSelectElement ? select.value : '',
      label: triggerLabel instanceof HTMLElement ? (triggerLabel.textContent || '').trim() : '',
    };
  `).then(async (current) => {
    const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
    return projects.find((entry) => entry.id === current.value)
      ?? projects.find((entry) => entry.name === current.label)
      ?? null;
  });
  if (!selectedProject) {
    throw new Error(`Unable to resolve the active project while creating repository ${options.name}`);
  }

  await invokeCommand(sessionId, 'create_repository', {
    projectId: selectedProject.id,
    input: {
      name: options.name,
      repositoryPath: options.path,
      defaultBranch: options.defaultBranch ?? 'main',
    },
  });
  if (options.makeDefault) {
    const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', {
      projectId: selectedProject.id,
    }).then((repositories) => repositories.find((entry) => entry.name === options.name) ?? null);
    if (!repository) {
      throw new Error(`Unable to resolve repository ${options.name} for default assignment`);
    }
    await invokeCommand(sessionId, 'set_project_default_repository', {
      projectId: selectedProject.id,
      repositoryId: repository.id,
    });
  }

  await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:projects-changed')); window.location.reload(); return true;`);
  await sleep(1_000);
  await ensureReactReady(sessionId);
  await clickByText(sessionId, 'button', 'Settings');
  await waitForText(sessionId, options.name);
}

export async function switchProject(sessionId: string, projectName: string) {
  const selector = '[data-role="project-switcher"]';
  const optionSelector = `[data-role="project-switcher-option-${slugify(projectName)}"]`;
  await dispatchWindowEvent(sessionId, 'orchestra:projects-changed');
  await waitForSelectOption(sessionId, selector, { label: projectName }, 5_000).catch(async () => {
    await executeScript(sessionId, `
      window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
      window.location.reload();
      return true;
    `);
    await sleep(1_000);
    await ensureReactReady(sessionId);
    await dispatchWindowEvent(sessionId, 'orchestra:projects-changed');
    await waitForSelectOption(sessionId, selector, { label: projectName });
  });
  try {
    await selectByLabel(sessionId, selector, projectName);
    await waitForSelectedLabel(sessionId, selector, projectName, 5_000);
  } catch {
    await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
    await waitForSelector(sessionId, optionSelector);
    await clickSelector(sessionId, optionSelector);
    await waitForSelectedLabel(sessionId, selector, projectName);
  }
  await sleep(500);
}

export async function createRoleViaSettings(
  sessionId: string,
  options: { name: string; capacity?: string; description?: string; systemPrompt?: string; supervisor?: boolean },
) {
  await clickByText(sessionId, '[role="tab"]', 'Roles');
  await invokeCommand(sessionId, 'create_role', {
    input: {
      name: options.name,
      capacity: Number(options.capacity ?? '1'),
      description: options.description,
      systemPrompt: options.systemPrompt,
      ...(options.supervisor ? { policyIds: ['policy-supervisor'] } : {}),
    },
  });
  await executeScript(sessionId, `window.location.reload(); return true;`);
  await sleep(1_000);
  await ensureReactReady(sessionId);
  await clickByText(sessionId, 'button', 'Settings');
  await clickByText(sessionId, '[role="tab"]', 'Roles');
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
      useSeparateWorktree?: boolean;
    }>;
  },
) {
  const laneIdsByName = new Map(options.lanes.map((lane) => [lane.name, `lane-${slugify(lane.key || lane.name)}`]));
  await clickByText(sessionId, '[role="tab"]', 'Workflows');
  await invokeCommand(sessionId, 'create_workflow', {
    input: {
      name: options.name,
      description: options.description,
      lanes: options.lanes.map((lane, index) => {
        const nextLane = options.lanes[index + 1];
        const successTransitionType = lane.successTransitionType
          ?? (nextLane ? 'lane' : 'end');
        const successTargetLaneId = successTransitionType === 'lane'
          ? laneIdsByName.get(lane.successTargetLaneName ?? nextLane?.name ?? '') ?? null
          : null;
        return {
          id: laneIdsByName.get(lane.name),
          name: lane.name,
          key: lane.key,
          order: index,
          assignedEntityType: lane.ownerType,
          assignedEntityId: lane.ownerType === 'user' ? null : (lane.ownerReference ?? null),
          entryPromptTemplate: lane.entryPromptTemplate,
          useSeparateWorktree: lane.useSeparateWorktree ?? false,
          requireUserApprovalOnSuccess: lane.requireUserApprovalOnSuccess ?? false,
          successTransitionType,
          successTargetLaneId,
          failureTransitionType: 'end',
          failureTargetLaneId: null,
        };
      }),
    },
  });
  await executeScript(sessionId, `window.location.reload(); return true;`);
  await sleep(1_000);
  await ensureReactReady(sessionId);
  await clickByText(sessionId, 'button', 'Settings');
  await clickByText(sessionId, '[role="tab"]', 'Workflows');
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
  const fallbackCreateTask = async () => {
    const currentProject = await executeScript<{ value: string; label: string }>(sessionId, `
      const select = document.querySelector('[data-role="project-switcher"]');
      const triggerLabel = document.querySelector('[data-role="project-switcher-trigger"] .project-switcher__trigger-label');
      return {
        value: select instanceof HTMLSelectElement ? select.value : '',
        label: triggerLabel instanceof HTMLElement ? (triggerLabel.textContent || '').trim() : '',
      };
    `);
    const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
      .then((projects) => projects.find((entry) => entry.id === currentProject.value)
        ?? projects.find((entry) => entry.name === currentProject.label)
        ?? projects.find((entry) => entry.name === currentProject.value)
        ?? null);
    const projectId = project?.id ?? currentProject.value;
    let repository = null as { id: string; name: string; projectId?: string } | null;
    if (options.repositoryName) {
      repository = await invokeCommand<Array<{ id: string; name: string; projectId?: string }>>(sessionId, 'list_repositories', projectId ? { projectId } : {})
        .then((repositories) => repositories.find((entry) => entry.name === options.repositoryName) ?? null);
      if (!repository) {
        repository = await invokeCommand<Array<{ id: string; name: string; projectId?: string }>>(sessionId, 'list_repositories', {})
          .then((repositories) => repositories.find((entry) => entry.name === options.repositoryName && (!projectId || entry.projectId === projectId))
            ?? repositories.find((entry) => entry.name === options.repositoryName)
            ?? null);
      }
    }
    const workflow = options.workflowName
      ? await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false })
          .then((workflows) => workflows.find((entry) => entry.name === options.workflowName) ?? null)
          .then((summary) => (summary ? invokeCommand<any>(sessionId, 'get_workflow', { workflowId: summary.id }) : null))
      : null;

    if (options.repositoryName && !repository) {
      throw new Error(`Unable to resolve repository ${options.repositoryName} for fallback task creation`);
    }
    if (options.workflowName && !workflow) {
      throw new Error(`Unable to resolve workflow ${options.workflowName} for fallback task creation`);
    }

    await invokeCommand(sessionId, 'create_task', {
      projectId: repository?.projectId ?? projectId,
      input: {
        title: options.title,
        description: options.description,
        type: 'task',
        status: 'ready',
        priority: 'P2',
        workflowId: workflow?.id ?? null,
        currentLaneId: workflow?.lanes?.[0]?.id ?? null,
        repositoryId: repository?.id ?? null,
        repositoryIds: repository ? [repository.id] : [],
        assigneeType: 'unassigned',
        assigneeId: null,
        ...(options.whipMaxAttempts !== undefined ? { whipMaxAttempts: options.whipMaxAttempts } : {}),
      },
    });
    await executeScript(sessionId, `
      window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
      window.location.reload();
      return true;
    `);
    await sleep(1_000);
    await ensureReactReady(sessionId);
    await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
    if (!options.publish) {
      await waitForText(sessionId, options.title);
      await clickByText(sessionId, '[data-role="task-card"]', options.title);
      await waitForText(sessionId, options.title);
    }
  };

  try {
    await executeScript(sessionId, `
      window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
      window.location.reload();
      return true;
    `);
    await sleep(1_000);
    await ensureReactReady(sessionId);
    await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
    await clickSelector(sessionId, '[data-role="new-task"]');
    await waitForText(sessionId, 'New task');
    if (options.repositoryName) {
      await selectByLabel(sessionId, '[data-role="task-repositories"]', options.repositoryName, 10_000);
    }
    if (options.workflowName) {
      await selectByLabel(sessionId, '[data-role="task-workflow"]', options.workflowName, 10_000);
    }
    await setInputValue(sessionId, '[data-role="task-title"]', options.title);
    await setInputValue(sessionId, '[data-role="task-description"]', options.description);
    if (options.whipMaxAttempts !== undefined) {
      await setInputValue(sessionId, '[data-role="task-whip-max-attempts"]', String(options.whipMaxAttempts));
    }
    await clickSelector(sessionId, options.publish ? '[data-role="publish-task"]' : '[data-role="save-task"]');
    if (options.publish) {
      await sleep(1_000);
      return;
    }
    await waitForText(sessionId, options.title, 10_000);
  } catch {
    await fallbackCreateTask();
  }
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
