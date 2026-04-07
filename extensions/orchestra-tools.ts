import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type AuthorizationContext = { actorType: string; actorId: string } | null;
type OrchestraToolDefinition = { name: string; description: string; requiredPermission: string };

type TaskInputParams = {
  title: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  workflowId?: string;
  currentLaneId?: string;
  assigneeType?: string;
  assigneeId?: string;
  repositoryId?: string;
  repositoryIds?: string[];
  parentTaskId?: string;
  whipMaxAttempts?: number;
  archived?: boolean;
};

type ProjectInputParams = {
  name: string;
  description?: string;
};

type RepositoryInputParams = {
  name: string;
  mode?: string;
  repositoryPath?: string;
  defaultBranch?: string;
};

type BridgeConfig = {
  bridgeUrl: string;
  token: string;
  bridgeInstanceId: string | null;
  clientId: string | null;
  sessionId: string | null;
  allowedCommands: OrchestraToolDefinition[];
  authorization: AuthorizationContext;
};

export function getBridgeConfig() {
  const bridgeUrl = process.env.ORCHESTRA_BRIDGE_URL;
  const token = process.env.ORCHESTRA_BRIDGE_TOKEN;
  const bridgeInstanceId = process.env.ORCHESTRA_BRIDGE_INSTANCE_ID ?? null;
  const clientId = process.env.ORCHESTRA_BRIDGE_CLIENT_ID ?? null;
  const sessionId = process.env.ORCHESTRA_BRIDGE_SESSION_ID ?? null;
  const allowedCommandsRaw = process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON;
  const authorizationRaw = process.env.ORCHESTRA_AUTH_CONTEXT_JSON;

  if (!bridgeUrl || !token || !allowedCommandsRaw) {
    return null;
  }

  const allowedCommands = JSON.parse(allowedCommandsRaw) as OrchestraToolDefinition[];
  const authorization = authorizationRaw ? (JSON.parse(authorizationRaw) as AuthorizationContext) : null;
  return { bridgeUrl, token, bridgeInstanceId, clientId, sessionId, allowedCommands, authorization } satisfies BridgeConfig;
}

function isTransientBridgeFetchError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("fetch failed") || message.includes("econnrefused") || message.includes("econnreset");
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createBridgeRequestId() {
  return `bridge-request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function invokeBridge(command: string, payload: Record<string, unknown>) {
  const config = getBridgeConfig();
  if (!config) {
    throw new Error("Orchestra bridge is not configured for this session.");
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${config.bridgeUrl}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: config.token,
          command,
          authorization: config.authorization,
          payload,
          requestId: createBridgeRequestId(),
          clientId: config.clientId,
          sessionId: config.sessionId,
          bridgeInstanceId: config.bridgeInstanceId,
          sentAt: new Date().toISOString(),
        }),
      });

      const body = (await response.json()) as { success: boolean; data?: unknown; error?: string };
      if (!body.success) {
        throw new Error(body.error ?? `Orchestra bridge command failed: ${command}`);
      }

      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isTransientBridgeFetchError(error)) {
        break;
      }
      await delay(100 * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`Orchestra bridge request failed for ${command}: ${message}`);
}

function summarizeParameterType(schema: { type?: string; items?: { type?: string } }) {
  if (schema.type === "array") {
    return `array<${schema.items?.type ?? "unknown"}>`;
  }
  return schema.type ?? "unknown";
}

function summarizeToolParameters(tool?: { parameters?: { properties?: Record<string, { type?: string; description?: string; items?: { type?: string } }>; required?: string[] } }) {
  const properties = tool?.parameters?.properties ?? {};
  const required = new Set(tool?.parameters?.required ?? []);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: summarizeParameterType(schema),
    required: required.has(name),
    description: schema.description ?? null,
  }));
}

function buildAllowedCommandHelp(allowedCommands: OrchestraToolDefinition[]) {
  return allowedCommands
    .map((tool) => `- ${tool.name} (${tool.requiredPermission}) — ${tool.description}`)
    .join("\n");
}

function resolveHelpResult(
  allowedCommands: OrchestraToolDefinition[],
  registeredBridgeTools: Array<{ name: string; description: string; parameters?: { properties?: Record<string, { type?: string; description?: string; items?: { type?: string } }>; required?: string[] } }>,
  command?: string,
) {
  if (!command) {
    return {
      commands: allowedCommands,
      helpText: `${buildAllowedCommandHelp(allowedCommands)}\n\nUse orchestra_help with {\"command\":\"<tool>\"} or /orchestra-run help <tool> for parameter details.`,
    };
  }

  const allowed = allowedCommands.find((tool) => tool.name === command);
  if (!allowed) {
    throw new Error(`Command ${command} is not available in this session.`);
  }

  const bridgeTool = registeredBridgeTools.find((tool) => tool.name === command);
  return {
    command: allowed.name,
    description: allowed.description,
    requiredPermission: allowed.requiredPermission,
    parameters: summarizeToolParameters(bridgeTool),
  };
}

export function parseInputJson(inputJson: unknown) {
  if (typeof inputJson !== "string" || inputJson.trim().length === 0) {
    return {};
  }
  return JSON.parse(inputJson) as Record<string, unknown>;
}

function buildTaskInput(params: TaskInputParams) {
  return {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    type: params.type ?? "task",
    status: params.status ?? "ready",
    priority: params.priority ?? "P2",
    ...(params.workflowId !== undefined ? { workflowId: params.workflowId } : {}),
    ...(params.currentLaneId !== undefined ? { currentLaneId: params.currentLaneId } : {}),
    assigneeType: params.assigneeType ?? "unassigned",
    ...(params.assigneeId !== undefined ? { assigneeId: params.assigneeId } : {}),
    ...(params.repositoryId !== undefined ? { repositoryId: params.repositoryId } : {}),
    ...(params.repositoryIds !== undefined ? { repositoryIds: params.repositoryIds } : {}),
    ...(params.parentTaskId !== undefined ? { parentTaskId: params.parentTaskId } : {}),
    ...(params.whipMaxAttempts !== undefined ? { whipMaxAttempts: params.whipMaxAttempts } : {}),
    ...(params.archived !== undefined ? { archived: params.archived } : {}),
  };
}

function buildProjectInput(params: ProjectInputParams) {
  return {
    name: params.name,
    ...(params.description !== undefined ? { description: params.description } : {}),
  };
}

function buildRepositoryInput(params: RepositoryInputParams) {
  return {
    name: params.name,
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
    ...(params.repositoryPath !== undefined ? { repositoryPath: params.repositoryPath } : {}),
    ...(params.defaultBranch !== undefined ? { defaultBranch: params.defaultBranch } : {}),
  };
}

function workflowLaneSchema() {
  return Type.Object({
    id: Type.Optional(Type.String({ description: "Optional lane id. Omit when adding a new lane and Orchestra will generate one." })),
    key: Type.String({ description: "Stable lane key/slug." }),
    name: Type.String({ description: "Human-readable lane name." }),
    description: Type.Optional(Type.String({ description: "Optional lane description." })),
    order: Type.Optional(Type.Number({ description: "Optional zero-based lane order." })),
    assignedEntityType: Type.String({ description: "Lane owner type: user, agent, or role." }),
    assignedEntityId: Type.Optional(Type.String({ description: "Required for agent/role lanes. Omit for user lanes." })),
    entryPromptTemplate: Type.Optional(Type.String({ description: "Optional entry prompt template for the lane." })),
    useSeparateWorktree: Type.Optional(Type.Boolean({ description: "Whether this lane should use a separate worktree when supported." })),
    requireUserApprovalOnSuccess: Type.Optional(Type.Boolean({ description: "Whether lane completion should wait for user approval before advancing." })),
    successTransitionType: Type.String({ description: "Success transition type: lane, user_intervention, or end." }),
    successTargetLaneId: Type.Optional(Type.String({ description: "Required when successTransitionType is lane." })),
    failureTransitionType: Type.String({ description: "Failure transition type: lane, user_intervention, or end." }),
    failureTargetLaneId: Type.Optional(Type.String({ description: "Required when failureTransitionType is lane." })),
  });
}

function workflowLanePatchSchema() {
  return Type.Object({
    key: Type.Optional(Type.String({ description: "Optional updated lane key/slug." })),
    name: Type.Optional(Type.String({ description: "Optional updated lane name." })),
    description: Type.Optional(Type.String({ description: "Optional updated lane description." })),
    order: Type.Optional(Type.Number({ description: "Optional updated zero-based order." })),
    assignedEntityType: Type.Optional(Type.String({ description: "Optional updated lane owner type: user, agent, or role." })),
    assignedEntityId: Type.Optional(Type.String({ description: "Optional updated lane owner id." })),
    entryPromptTemplate: Type.Optional(Type.String({ description: "Optional updated entry prompt template." })),
    useSeparateWorktree: Type.Optional(Type.Boolean({ description: "Optional updated separate-worktree flag." })),
    requireUserApprovalOnSuccess: Type.Optional(Type.Boolean({ description: "Optional updated user-approval-on-success flag." })),
    successTransitionType: Type.Optional(Type.String({ description: "Optional updated success transition type: lane, user_intervention, or end." })),
    successTargetLaneId: Type.Optional(Type.String({ description: "Optional updated success target lane id." })),
    failureTransitionType: Type.Optional(Type.String({ description: "Optional updated failure transition type: lane, user_intervention, or end." })),
    failureTargetLaneId: Type.Optional(Type.String({ description: "Optional updated failure target lane id." })),
  });
}

function workflowSchemaDescription(tool: OrchestraToolDefinition) {
  return `${tool.description} Requires permission: ${tool.requiredPermission}.`;
}

export function createBridgeTool(tool: OrchestraToolDefinition) {
  if (tool.name === "list_projects") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. No input is required.`,
      parameters: Type.Object({}),
      async execute() {
        const payload = {};
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_project") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Orchestra project id to load." }),
      }),
      async execute(_toolCallId: string, params: { projectId: string }) {
        const payload = { projectId: params.projectId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_project") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide the project name and optional description.`,
      parameters: Type.Object({
        name: Type.String({ description: "Project name." }),
        description: Type.Optional(Type.String({ description: "Optional project description." })),
      }),
      async execute(_toolCallId: string, params: ProjectInputParams) {
        const payload = { input: buildProjectInput(params) };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_project") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId plus the new name and optional description.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Project id to update." }),
        name: Type.String({ description: "Updated project name." }),
        description: Type.Optional(Type.String({ description: "Optional updated project description." })),
      }),
      async execute(_toolCallId: string, params: { projectId: string } & ProjectInputParams) {
        const payload = {
          projectId: params.projectId,
          input: buildProjectInput(params),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "delete_project") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId. This removes the project and its Orchestra-managed state.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Project id to delete." }),
      }),
      async execute(_toolCallId: string, params: { projectId: string }) {
        const payload = { projectId: params.projectId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_repositories") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional projectId to scope repositories to one project.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope the repository list." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string }) {
        const payload = params.projectId ? { projectId: params.projectId } : {};
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_repository") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide repositoryId.`,
      parameters: Type.Object({
        repositoryId: Type.String({ description: "Orchestra repository id to load." }),
      }),
      async execute(_toolCallId: string, params: { repositoryId: string }) {
        const payload = { repositoryId: params.repositoryId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_repository") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId plus repository metadata.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Project id that should own the repository." }),
        name: Type.String({ description: "Repository display name." }),
        mode: Type.Optional(Type.String({ description: "Repository mode, such as existing or local_new." })),
        repositoryPath: Type.Optional(Type.String({ description: "Optional source repository path when attaching an existing repository." })),
        defaultBranch: Type.Optional(Type.String({ description: "Optional default branch." })),
      }),
      async execute(_toolCallId: string, params: { projectId: string } & RepositoryInputParams) {
        const payload = {
          projectId: params.projectId,
          input: buildRepositoryInput(params),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_repository") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide repositoryId plus updated repository metadata.`,
      parameters: Type.Object({
        repositoryId: Type.String({ description: "Repository id to update." }),
        name: Type.String({ description: "Updated repository display name." }),
        mode: Type.Optional(Type.String({ description: "Repository mode, such as existing or local_new." })),
        repositoryPath: Type.Optional(Type.String({ description: "Optional source repository path when updating an existing repository." })),
        defaultBranch: Type.Optional(Type.String({ description: "Optional default branch." })),
      }),
      async execute(_toolCallId: string, params: { repositoryId: string } & RepositoryInputParams) {
        const payload = {
          repositoryId: params.repositoryId,
          input: buildRepositoryInput(params),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "delete_repository") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide repositoryId.`,
      parameters: Type.Object({
        repositoryId: Type.String({ description: "Repository id to delete." }),
      }),
      async execute(_toolCallId: string, params: { repositoryId: string }) {
        const payload = { repositoryId: params.repositoryId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "attach_repository_remote") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide repositoryId plus the remote URL and optional remote name.`,
      parameters: Type.Object({
        repositoryId: Type.String({ description: "Repository id whose remote should be attached or updated." }),
        remoteUrl: Type.String({ description: "Remote URL to attach." }),
        remoteName: Type.Optional(Type.String({ description: "Optional remote name. Defaults to the service default if omitted." })),
      }),
      async execute(_toolCallId: string, params: { repositoryId: string; remoteUrl: string; remoteName?: string }) {
        const payload = {
          repositoryId: params.repositoryId,
          input: {
            remoteUrl: params.remoteUrl,
            ...(params.remoteName !== undefined ? { remoteName: params.remoteName } : {}),
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "set_project_default_repository") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId and optionally repositoryId (omit it to clear the default).`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Project id whose default repository should be updated." }),
        repositoryId: Type.Optional(Type.String({ description: "Optional repository id to make the default for the project." })),
      }),
      async execute(_toolCallId: string, params: { projectId: string; repositoryId?: string }) {
        const payload = {
          projectId: params.projectId,
          ...(params.repositoryId !== undefined ? { repositoryId: params.repositoryId } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_workflows") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Optionally include archived workflows.`,
      parameters: Type.Object({
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived workflows should be included." })),
      }),
      async execute(_toolCallId: string, params: { includeArchived?: boolean }) {
        const payload = {
          ...(params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide workflowId to inspect the full workflow and its lanes.`,
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to load." }),
      }),
      async execute(_toolCallId: string, params: { workflowId: string }) {
        const payload = { workflowId: params.workflowId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "validate_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide the workflow definition you want validated.`,
      parameters: Type.Object({
        name: Type.String({ description: "Workflow name." }),
        description: Type.Optional(Type.String({ description: "Optional workflow description." })),
        lanes: Type.Array(workflowLaneSchema(), { description: "Workflow lanes to validate." }),
      }),
      async execute(_toolCallId: string, params: { name: string; description?: string; lanes: unknown[] }) {
        const payload = {
          input: {
            name: params.name,
            ...(params.description !== undefined ? { description: params.description } : {}),
            lanes: params.lanes,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflow metadata plus the full lane array.",
      parameters: Type.Object({
        name: Type.String({ description: "Workflow name." }),
        description: Type.Optional(Type.String({ description: "Optional workflow description." })),
        lanes: Type.Array(workflowLaneSchema(), { description: "Workflow lanes to create." }),
      }),
      async execute(_toolCallId: string, params: { name: string; description?: string; lanes: unknown[] }) {
        const payload = {
          input: {
            name: params.name,
            ...(params.description !== undefined ? { description: params.description } : {}),
            lanes: params.lanes,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId plus the full updated lane array.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to update." }),
        name: Type.String({ description: "Updated workflow name." }),
        description: Type.Optional(Type.String({ description: "Optional updated workflow description." })),
        lanes: Type.Array(workflowLaneSchema(), { description: "Full updated workflow lanes array." }),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; name: string; description?: string; lanes: unknown[] }) {
        const payload = {
          workflowId: params.workflowId,
          input: {
            name: params.name,
            ...(params.description !== undefined ? { description: params.description } : {}),
            lanes: params.lanes,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "add_workflow_lane") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId plus the new lane definition.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id that should receive the new lane." }),
        input: workflowLaneSchema(),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; input: unknown }) {
        const payload = {
          workflowId: params.workflowId,
          input: params.input,
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_workflow_lane") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId, laneId, and the lane patch fields you want to change.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id that owns the lane." }),
        laneId: Type.String({ description: "Workflow lane id to update." }),
        input: workflowLanePatchSchema(),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; laneId: string; input: unknown }) {
        const payload = {
          workflowId: params.workflowId,
          laneId: params.laneId,
          input: params.input,
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "delete_workflow_lane") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId and laneId.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id that owns the lane." }),
        laneId: Type.String({ description: "Workflow lane id to delete." }),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; laneId: string }) {
        const payload = {
          workflowId: params.workflowId,
          laneId: params.laneId,
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "reorder_workflow_lanes") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId and the complete ordered laneIds array.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id whose lanes should be reordered." }),
        laneIds: Type.Array(Type.String({ description: "Lane id in the desired order." })),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; laneIds: string[] }) {
        const payload = {
          workflowId: params.workflowId,
          input: {
            laneIds: params.laneIds,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "duplicate_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId and optionally a newName.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to duplicate." }),
        newName: Type.Optional(Type.String({ description: "Optional name for the duplicated workflow." })),
      }),
      async execute(_toolCallId: string, params: { workflowId: string; newName?: string }) {
        const payload = {
          workflowId: params.workflowId,
          ...(params.newName !== undefined ? { newName: params.newName } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "archive_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to archive." }),
      }),
      async execute(_toolCallId: string, params: { workflowId: string }) {
        const payload = { workflowId: params.workflowId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_tasks") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional projectId and includeArchived to scope the task list.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope the task list." })),
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived tasks should be included." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string; includeArchived?: boolean }) {
        const payload = {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_task") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide title and optionally projectId plus task metadata.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id that should own the created task." })),
        title: Type.String({ description: "Task title." }),
        description: Type.Optional(Type.String({ description: "Optional task description." })),
        type: Type.Optional(Type.String({ description: "Optional task type such as task, bug, feature, chore, or epic." })),
        status: Type.Optional(Type.String({ description: "Optional task status such as draft, ready, in_progress, blocked, in_review, completed, or canceled." })),
        priority: Type.Optional(Type.String({ description: "Optional priority such as P0 through P4." })),
        workflowId: Type.Optional(Type.String({ description: "Optional workflow id to attach to the task." })),
        currentLaneId: Type.Optional(Type.String({ description: "Optional current workflow lane id." })),
        assigneeType: Type.Optional(Type.String({ description: "Optional assignee type such as unassigned, user, agent, or role." })),
        assigneeId: Type.Optional(Type.String({ description: "Optional assignee id when the task is assigned." })),
        repositoryId: Type.Optional(Type.String({ description: "Optional primary repository id for the task." })),
        repositoryIds: Type.Optional(Type.Array(Type.String({ description: "Repository id linked to the task." }))),
        parentTaskId: Type.Optional(Type.String({ description: "Optional parent task id for hierarchy." })),
        whipMaxAttempts: Type.Optional(Type.Number({ description: "Optional maximum whip count for the task lane." })),
        archived: Type.Optional(Type.Boolean({ description: "Whether the task should be created archived." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string } & TaskInputParams) {
        const payload = {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          input: buildTaskInput(params),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_worker_overlay") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide workerType, workerSlug, and optionally projectSlug.`,
      parameters: Type.Object({
        workerType: Type.String({ description: "Worker type, usually agent or role." }),
        workerSlug: Type.String({ description: "Worker slug to inspect." }),
        projectSlug: Type.Optional(Type.String({ description: "Optional Orchestra project slug to read from." })),
      }),
      async execute(_toolCallId: string, params: { workerType: string; workerSlug: string; projectSlug?: string }) {
        const payload = {
          workerType: params.workerType,
          workerSlug: params.workerSlug,
          ...(params.projectSlug ? { projectSlug: params.projectSlug } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_worker_overlay") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide workerType, workerSlug, prompt, and optionally projectSlug.`,
      parameters: Type.Object({
        workerType: Type.String({ description: "Worker type, usually agent or role." }),
        workerSlug: Type.String({ description: "Worker slug to update." }),
        prompt: Type.Optional(Type.String({ description: "Optional overlay prompt. Omit or pass an empty string to clear it." })),
        projectSlug: Type.Optional(Type.String({ description: "Optional Orchestra project slug to update." })),
      }),
      async execute(_toolCallId: string, params: { workerType: string; workerSlug: string; prompt?: string; projectSlug?: string }) {
        const payload = {
          workerType: params.workerType,
          workerSlug: params.workerSlug,
          ...(params.projectSlug ? { projectSlug: params.projectSlug } : {}),
          ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "comment_on_task") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId, author, message, and optionally interruptAgent and parentCommentId.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        author: Type.String({ description: "Comment author name to record on the task." }),
        message: Type.String({ description: "Durable task comment text describing what happened and why." }),
        interruptAgent: Type.Optional(Type.Boolean({ description: "Whether this comment should interrupt an active worker immediately." })),
        parentCommentId: Type.Optional(Type.String({ description: "Existing top-level task comment id to reply to." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string; author: string; message: string; interruptAgent?: boolean; parentCommentId?: string }) {
        const payload = {
          taskId: params.taskId,
          input: {
            author: params.author,
            message: params.message,
            interruptAgent: params.interruptAgent ?? false,
            parentCommentId: params.parentCommentId ?? null,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["get_task_context", "get_task_repositories", "list_task_comments", "get_unread_task_comments", "list_task_file_references", "list_task_todos"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
      }),
      async execute(_toolCallId: string, params: { taskId: string }) {
        const payload = { taskId: params.taskId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_unfinished_task_todos") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and optionally laneId to scope unfinished todos to one lane.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        laneId: Type.Optional(Type.String({ description: "Optional workflow lane id to scope unfinished todos." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string; laneId?: string }) {
        const payload = {
          taskId: params.taskId,
          ...(params.laneId ? { laneId: params.laneId } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "add_task_file_reference") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId, repositoryId, and relativePath.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        repositoryId: Type.String({ description: "Repository id that owns the tracked file." }),
        relativePath: Type.String({ description: "Repository-relative file path to track, e.g. docs/design.md." }),
      }),
      async execute(_toolCallId: string, params: { taskId: string; repositoryId: string; relativePath: string }) {
        const payload = {
          taskId: params.taskId,
          input: {
            repositoryId: params.repositoryId,
            relativePath: params.relativePath,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "add_task_todo") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide description and optionally taskId and laneId. In a worker session, omitting taskId and laneId defaults to the active assignment.`,
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "Optional canonical Orchestra task id. Omit in an active worker session to use the current task." })),
        laneId: Type.Optional(Type.String({ description: "Optional workflow lane id. Omit in an active worker session to use the current lane." })),
        description: Type.String({ description: "Todo description to track on the task." }),
      }),
      async execute(_toolCallId: string, params: { taskId?: string; laneId?: string; description: string }) {
        const payload = {
          ...(params.taskId ? { taskId: params.taskId } : {}),
          input: {
            ...(params.laneId ? { laneId: params.laneId } : {}),
            description: params.description,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["mark_task_todo_finished", "mark_task_todo_unfinished", "delete_task_todo"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide todoId.`,
      parameters: Type.Object({
        todoId: Type.String({ description: "Task todo id to update." }),
      }),
      async execute(_toolCallId: string, params: { todoId: string }) {
        const payload = { todoId: params.todoId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "remove_task_file_reference") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide referenceId.`,
      parameters: Type.Object({
        referenceId: Type.String({ description: "Task file reference id to remove." }),
      }),
      async execute(_toolCallId: string, params: { referenceId: string }) {
        const payload = { referenceId: params.referenceId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "mark_task_comments_read") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and optionally commentIds.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        commentIds: Type.Optional(Type.Array(Type.String({ description: "Task comment id to acknowledge as read." }))),
      }),
      async execute(_toolCallId: string, params: { taskId: string; commentIds?: string[] }) {
        const payload = {
          taskId: params.taskId,
          input: {
            commentIds: params.commentIds,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_unread_mail") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional taskId to include the active assignment mailbox.`,
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "Optional canonical Orchestra task id, e.g. task-123" })),
      }),
      async execute(_toolCallId: string, params: { taskId?: string }) {
        const payload = params.taskId ? { taskId: params.taskId } : {};
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "mark_mail_read") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional taskId and deliveryIds.`,
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "Optional canonical Orchestra task id, e.g. task-123" })),
        deliveryIds: Type.Optional(Type.Array(Type.String({ description: "Mailbox delivery id to acknowledge as read." }))),
      }),
      async execute(_toolCallId: string, params: { taskId?: string; deliveryIds?: string[] }) {
        const payload = {
          ...(params.taskId ? { taskId: params.taskId } : {}),
          input: {
            deliveryIds: params.deliveryIds,
          },
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "send_mail") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide recipientType, body, and optionally projectId, taskId, recipientId, and priority.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id for general agent mail without a task context." })),
        taskId: Type.Optional(Type.String({ description: "Optional canonical Orchestra task id, e.g. task-123" })),
        recipientType: Type.String({ description: "Mailbox recipient type: user, agent, or active_assignment." }),
        recipientId: Type.Optional(Type.String({ description: "Recipient id for agent or assignment delivery targets." })),
        body: Type.String({ description: "Mailbox message body." }),
        priority: Type.Optional(Type.String({ description: "Optional priority: normal or interrupt." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string; taskId?: string; recipientType: string; recipientId?: string; body: string; priority?: string }) {
        const payload = {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.taskId ? { taskId: params.taskId } : {}),
          recipientType: params.recipientType,
          ...(params.recipientId ? { recipientId: params.recipientId } : {}),
          body: params.body,
          ...(params.priority ? { priority: params.priority } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }
  return {
    name: tool.name,
    label: `Orchestra · ${tool.name}`,
    description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional inputJson when the command needs arguments.`,
    parameters: Type.Object({
      inputJson: Type.Optional(
        Type.String({
          description: "Optional JSON object string for the command input payload, e.g. {\"taskId\":\"task-1\",\"notes\":\"Done\"}",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { inputJson?: string }) {
      const payload = parseInputJson(params.inputJson);
      const result = await invokeBridge(tool.name, payload);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { command: tool.name, payload, result },
      };
    },
  };
}

export default function orchestraToolsExtension(pi: ExtensionAPI) {
  const config = getBridgeConfig();
  if (!config) {
    return;
  }

  const bridgeTools = config.allowedCommands.map((tool) => createBridgeTool(tool));
  const allowedCommandHelp = buildAllowedCommandHelp(config.allowedCommands);

  pi.registerCommand("orchestra-tools", {
    description: "List Orchestra commands available to this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Available Orchestra commands:\n${allowedCommandHelp}`, "info");
    },
  });

  pi.registerCommand("orchestra-run", {
    description: "Run an Orchestra bridge command: /orchestra-run <command> [json]",
    handler: async (args, ctx) => {
      const [command, ...jsonParts] = args.trim().split(/\s+/);
      if (!command) {
        ctx.ui.notify("Usage: /orchestra-run <command> [json]", "warning");
        return;
      }
      if (command === "help") {
        try {
          const requestedCommand = jsonParts.join(" ").trim() || undefined;
          const result = resolveHelpResult(config.allowedCommands, bridgeTools, requestedCommand);
          if (!requestedCommand) {
            ctx.ui.notify(`Available Orchestra commands:\n${result.helpText}`, "info");
          } else {
            ctx.ui.notify(JSON.stringify(result, null, 2), "info");
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }
      if (!config.allowedCommands.some((tool) => tool.name === command)) {
        ctx.ui.notify(`Command ${command} is not available in this session.`, "warning");
        return;
      }
      const payloadText = jsonParts.join(" ").trim();
      const payload = payloadText ? JSON.parse(payloadText) : {};
      const result = await invokeBridge(command, payload as Record<string, unknown>);
      ctx.ui.notify(JSON.stringify(result, null, 2), "info");
    },
  });

  const helpTool = {
    name: "orchestra_help",
    label: "Orchestra Help",
    description: "List Orchestra backend commands available to this session or inspect a specific command's parameters.",
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: "Optional Orchestra command name to inspect in detail." })),
    }),
    async execute(_toolCallId: string, params: { command?: string }) {
      const result = resolveHelpResult(config.allowedCommands, bridgeTools, params.command);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { command: "help", requestedCommand: params.command ?? null, result },
      };
    },
  };
  pi.registerTool(helpTool);

  for (const bridgeTool of bridgeTools) {
    pi.registerTool(bridgeTool);
  }
}
