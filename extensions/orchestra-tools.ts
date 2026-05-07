import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, extname, resolve } from "node:path";

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
  tags?: string[];
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

type HelpParameterSchema = {
  type?: string;
  description?: string;
  items?: HelpParameterSchema;
  properties?: Record<string, HelpParameterSchema>;
  required?: string[];
  enum?: unknown[];
  examples?: unknown[];
  anyOf?: HelpParameterSchema[];
  oneOf?: HelpParameterSchema[];
};

type RegisteredBridgeTool = {
  name: string;
  description: string;
  parameters?: HelpParameterSchema;
  helpExamples?: unknown[];
  helpNotes?: string[];
};

function summarizeParameterType(schema: HelpParameterSchema) {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants?.length) {
    return variants.map((variant) => summarizeParameterType(variant)).join(" | ");
  }
  if (schema.type === "array") {
    return `array<${schema.items ? summarizeParameterType(schema.items) : "unknown"}>`;
  }
  return schema.type ?? "unknown";
}

function summarizeParameterSchema(name: string | null, schema: HelpParameterSchema, required: boolean) {
  const summary: Record<string, unknown> = {
    ...(name ? { name } : {}),
    type: summarizeParameterType(schema),
    required,
    description: schema.description ?? null,
  };

  if (schema.enum?.length) {
    summary.allowedValues = schema.enum;
  }

  if (schema.examples?.length) {
    summary.examples = schema.examples;
  }

  if (schema.properties) {
    const nestedRequired = new Set(schema.required ?? []);
    summary.properties = Object.entries(schema.properties).map(([childName, childSchema]) =>
      summarizeParameterSchema(childName, childSchema, nestedRequired.has(childName)),
    );
  }

  if (schema.items) {
    summary.items = summarizeParameterSchema(null, schema.items, false);
  }

  return summary;
}

function summarizeToolParameters(tool?: { parameters?: HelpParameterSchema }) {
  const properties = tool?.parameters?.properties ?? {};
  const required = new Set(tool?.parameters?.required ?? []);
  return Object.entries(properties).map(([name, schema]) => summarizeParameterSchema(name, schema, required.has(name)));
}

function buildAllowedCommandHelp(allowedCommands: OrchestraToolDefinition[]) {
  return allowedCommands
    .map((tool) => `- ${tool.name} (${tool.requiredPermission}) — ${tool.description}`)
    .join("\n");
}

function resolveHelpResult(
  allowedCommands: OrchestraToolDefinition[],
  registeredBridgeTools: RegisteredBridgeTool[],
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
    notes: bridgeTool?.helpNotes ?? [],
    examples: bridgeTool?.helpExamples ?? [],
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
    ...(params.tags !== undefined ? { tags: params.tags } : {}),
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

type AgentInputParams = {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  roleId?: string;
  scope?: string;
  projectId?: string;
  thinkingLevel?: string;
  compactionWindow?: string;
  policyIds?: string[];
  directPermissions?: string[];
};

type RoleInputParams = {
  name: string;
  description?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  capacity: number;
  compactionWindow?: string;
  policyIds?: string[];
  directPermissions?: string[];
};

type RoleQueueEntryParams = {
  roleId: string;
  sourceType: string;
  sourceTaskId?: string;
  sourceWorkflowId?: string;
  sourceLaneId?: string;
  title: string;
  summary?: string;
  entryPrompt?: string;
};

type ReminderParams = {
  message: string;
  delaySeconds?: number;
  delayMinutes?: number;
};

type TaskAttachmentBase64Params = {
  fileName: string;
  mediaType: string;
  base64Data: string;
  caption?: string;
  filePath?: never;
};

type TaskAttachmentFileParams = {
  filePath: string;
  fileName?: string;
  mediaType?: string;
  caption?: string;
  base64Data?: never;
};

type TaskAttachmentParams = TaskAttachmentBase64Params | TaskAttachmentFileParams;

type BridgeTaskAttachmentInput = {
  fileName: string;
  mediaType: string;
  base64Data: string;
  caption?: string;
};

type ResolvedTaskAttachmentInput = {
  bridgeInput: BridgeTaskAttachmentInput;
  auditInput: {
    inputMode: "filePath" | "base64Data";
    filePath?: string;
    resolvedPath?: string;
    fileName: string;
    mediaType: string;
    caption?: string;
  };
};

function buildAgentInput(params: AgentInputParams) {
  return {
    name: params.name,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.roleId !== undefined ? { roleId: params.roleId } : {}),
    ...(params.scope !== undefined ? { scope: params.scope } : {}),
    ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
    ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
    ...(params.compactionWindow !== undefined ? { compactionWindow: params.compactionWindow } : {}),
    ...(params.policyIds !== undefined ? { policyIds: params.policyIds } : {}),
    ...(params.directPermissions !== undefined ? { directPermissions: params.directPermissions } : {}),
  };
}

function buildRoleInput(params: RoleInputParams) {
  return {
    name: params.name,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.thinkingLevel !== undefined ? { thinkingLevel: params.thinkingLevel } : {}),
    capacity: params.capacity,
    ...(params.compactionWindow !== undefined ? { compactionWindow: params.compactionWindow } : {}),
    ...(params.policyIds !== undefined ? { policyIds: params.policyIds } : {}),
    ...(params.directPermissions !== undefined ? { directPermissions: params.directPermissions } : {}),
  };
}

function buildRoleQueueEntryInput(params: RoleQueueEntryParams) {
  return {
    roleId: params.roleId,
    sourceType: params.sourceType,
    ...(params.sourceTaskId !== undefined ? { sourceTaskId: params.sourceTaskId } : {}),
    ...(params.sourceWorkflowId !== undefined ? { sourceWorkflowId: params.sourceWorkflowId } : {}),
    ...(params.sourceLaneId !== undefined ? { sourceLaneId: params.sourceLaneId } : {}),
    title: params.title,
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
    ...(params.entryPrompt !== undefined ? { entryPrompt: params.entryPrompt } : {}),
  };
}

const ATTACHMENT_MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }

  return typeof error.code === "string" ? error.code : null;
}

function inferAttachmentMediaType(fileName: string) {
  return ATTACHMENT_MEDIA_TYPES_BY_EXTENSION[extname(fileName).toLowerCase()];
}

async function buildTaskAttachmentInput(params: TaskAttachmentParams): Promise<ResolvedTaskAttachmentInput> {
  const hasFilePath = typeof (params as { filePath?: unknown }).filePath === "string";
  const hasBase64Data = typeof (params as { base64Data?: unknown }).base64Data === "string";

  if (hasFilePath && hasBase64Data) {
    throw new Error("Attachment input must provide either input.filePath or input.base64Data, not both.");
  }

  if (!hasFilePath && !hasBase64Data) {
    throw new Error("Attachment input must provide either input.filePath for a readable local file or input.base64Data for an in-memory payload.");
  }

  if (hasFilePath) {
    const filePath = (params as TaskAttachmentFileParams).filePath.trim();
    if (!filePath) {
      throw new Error("input.filePath must not be empty.");
    }

    const absolutePath = resolve(process.cwd(), filePath);
    let resolvedPath: string;
    try {
      resolvedPath = await fs.realpath(absolutePath);
    } catch (error) {
      const errorCode = getErrorCode(error);
      if (errorCode === "ENOENT") {
        throw new Error(`Attachment file was not found: ${absolutePath}`);
      }
      if (errorCode === "EACCES" || errorCode === "EPERM") {
        throw new Error(`Attachment file is not readable from this session: ${absolutePath}`);
      }
      throw new Error(`Attachment file could not be resolved: ${absolutePath}`);
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
      await fs.access(resolvedPath, fsConstants.R_OK);
    } catch (error) {
      const errorCode = getErrorCode(error);
      if (errorCode === "EACCES" || errorCode === "EPERM") {
        throw new Error(`Attachment file is not readable from this session: ${resolvedPath}`);
      }
      throw new Error(`Attachment file could not be read: ${resolvedPath}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Attachment file must be a regular readable file, not a directory: ${resolvedPath}`);
    }

    const bytes = await fs.readFile(resolvedPath);
    const fileName = normalizeOptionalString(params.fileName) ?? basename(resolvedPath);
    const mediaType = normalizeOptionalString(params.mediaType)
      ?? inferAttachmentMediaType(fileName)
      ?? inferAttachmentMediaType(resolvedPath)
      ?? "application/octet-stream";

    return {
      bridgeInput: {
        fileName,
        mediaType,
        base64Data: bytes.toString("base64"),
        ...(params.caption !== undefined ? { caption: params.caption } : {}),
      },
      auditInput: {
        inputMode: "filePath",
        filePath: params.filePath,
        resolvedPath,
        fileName,
        mediaType,
        ...(params.caption !== undefined ? { caption: params.caption } : {}),
      },
    };
  }

  const fileName = normalizeOptionalString((params as TaskAttachmentBase64Params).fileName);
  if (!fileName) {
    throw new Error("input.fileName is required when using input.base64Data.");
  }

  const mediaType = normalizeOptionalString((params as TaskAttachmentBase64Params).mediaType);
  if (!mediaType) {
    throw new Error("input.mediaType is required when using input.base64Data.");
  }

  return {
    bridgeInput: {
      fileName,
      mediaType,
      base64Data: (params as TaskAttachmentBase64Params).base64Data,
      ...(params.caption !== undefined ? { caption: params.caption } : {}),
    },
    auditInput: {
      inputMode: "base64Data",
      fileName,
      mediaType,
      ...(params.caption !== undefined ? { caption: params.caption } : {}),
    },
  };
}

function buildReminderInput(params: ReminderParams) {
  return {
    message: params.message,
    ...(params.delaySeconds !== undefined ? { delaySeconds: params.delaySeconds } : {}),
    ...(params.delayMinutes !== undefined ? { delayMinutes: params.delayMinutes } : {}),
  };
}

function camelCaseInputNote(noun: string) {
  return `Use camelCase JSON field names for ${noun} input. Rust source types may use snake_case, but Orchestra tool payloads use camelCase.`;
}

function agentInputSchema() {
  return Type.Object(
    {
      name: Type.String({ description: "Agent display name." }),
      description: Type.Optional(Type.String({ description: "Optional agent description." })),
      systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt injected into the agent session." })),
      provider: Type.Optional(Type.String({ description: "Optional provider id. If provided, model is also required." })),
      model: Type.Optional(Type.String({ description: "Optional model id. If provided, provider is also required." })),
      roleId: Type.Optional(Type.String({ description: "Optional role id associated with this agent." })),
      scope: Type.Optional(Type.String({ description: "Optional scope: global or project. Defaults to global." })),
      projectId: Type.Optional(Type.String({ description: "Required when scope is project. Omit for global agents." })),
      thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, or xhigh." })),
      compactionWindow: Type.Optional(Type.String({ description: "Optional compaction window spec such as 32k, 50%, or 200 messages." })),
      policyIds: Type.Optional(Type.Array(Type.String({ description: "Policy id to attach to the agent." }))),
      directPermissions: Type.Optional(Type.Array(Type.String({ description: "Direct permission grant, e.g. tasks.read." }))),
    },
    {
      description:
        'Wrapped agent definition. Put the agent fields inside top-level input, e.g. {"input": {...}}. Use camelCase field names inside input.',
    },
  );
}

function roleInputSchema() {
  return Type.Object(
    {
      name: Type.String({ description: "Role display name." }),
      description: Type.Optional(Type.String({ description: "Optional role description." })),
      systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt injected into sessions launched for this role." })),
      provider: Type.Optional(Type.String({ description: "Optional provider id. If provided, model is also required." })),
      model: Type.Optional(Type.String({ description: "Optional model id. If provided, provider is also required." })),
      thinkingLevel: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, or xhigh." })),
      capacity: Type.Number({ description: "Maximum number of concurrent role instances. Must be at least 1." }),
      compactionWindow: Type.Optional(Type.String({ description: "Optional compaction window spec such as 32k, 50%, or 200 messages." })),
      policyIds: Type.Optional(Type.Array(Type.String({ description: "Policy id to attach to the role." }))),
      directPermissions: Type.Optional(Type.Array(Type.String({ description: "Direct permission grant, e.g. tasks.read." }))),
    },
    {
      description:
        'Wrapped role definition. Put the role fields inside top-level input, e.g. {"input": {...}}. Use camelCase field names inside input.',
    },
  );
}

function roleQueueEntrySchema() {
  return Type.Object(
    {
      roleId: Type.String({ description: "Role id that should receive the queued work." }),
      sourceType: Type.String({ description: "Source type for the queue entry, such as task or workflow." }),
      sourceTaskId: Type.Optional(Type.String({ description: "Optional task id that produced this queued work item." })),
      sourceWorkflowId: Type.Optional(Type.String({ description: "Optional workflow id that produced this queued work item." })),
      sourceLaneId: Type.Optional(Type.String({ description: "Optional workflow lane id that produced this queued work item." })),
      title: Type.String({ description: "Queue entry title shown to the role instance." }),
      summary: Type.Optional(Type.String({ description: "Optional short summary for the queued work." })),
      entryPrompt: Type.Optional(Type.String({ description: "Optional full prompt to hand to the role instance." })),
    },
    {
      description:
        'Wrapped role queue entry definition. Put the queue entry fields inside top-level input, e.g. {"input": {...}}. Use camelCase field names inside input.',
    },
  );
}

function taskAttachmentSchema() {
  return Type.Object(
    {
      filePath: Type.Optional(
        Type.String({
          description: "Preferred mode for on-disk files. Absolute paths are allowed; relative paths resolve from the session cwd. The path must point to a readable regular file.",
        }),
      ),
      fileName: Type.Optional(
        Type.String({
          description: "Optional stored file name override in filePath mode. Required when using base64Data.",
        }),
      ),
      mediaType: Type.Optional(
        Type.String({
          description: "Optional media type override in filePath mode. Required when using base64Data. When omitted in filePath mode, Orchestra infers a type from the file name or path and falls back to application/octet-stream.",
        }),
      ),
      base64Data: Type.Optional(
        Type.String({
          description: "Compatibility mode for in-memory bytes. Use when the file is not available as a readable local path in this session.",
        }),
      ),
      caption: Type.Optional(Type.String({ description: "Optional human-readable caption for the attachment." })),
    },
    {
      description:
        'Wrapped attachment payload. Put the attachment fields inside top-level input, e.g. {"input": {...}}. Use camelCase field names inside input. Provide either filePath or base64Data; base64Data mode also requires fileName and mediaType.',
    },
  );
}

function reminderInputSchema() {
  return Type.Object(
    {
      message: Type.String({ description: "Reminder message that Orchestra should send back later." }),
      delaySeconds: Type.Optional(Type.Number({ description: "Delay in seconds. Provide exactly one of delaySeconds or delayMinutes." })),
      delayMinutes: Type.Optional(Type.Number({ description: "Delay in minutes. Provide exactly one of delaySeconds or delayMinutes." })),
    },
    {
      description: "Reminder request. Provide exactly one of delaySeconds or delayMinutes.",
    },
  );
}

function transitionExamples(taskId = "task-123") {
  return [{ taskId, notes: "Implementation complete. Tests passed." }];
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
    needsWorkTargetLaneId: Type.Optional(Type.String({ description: "Optional review-only return lane used when a user clicks Needs Work after success approval is required." })),
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
    needsWorkTargetLaneId: Type.Optional(Type.String({ description: "Optional updated review-only Needs Work target lane id." })),
    successTransitionType: Type.Optional(Type.String({ description: "Optional updated success transition type: lane, user_intervention, or end." })),
    successTargetLaneId: Type.Optional(Type.String({ description: "Optional updated success target lane id." })),
    failureTransitionType: Type.Optional(Type.String({ description: "Optional updated failure transition type: lane, user_intervention, or end." })),
    failureTargetLaneId: Type.Optional(Type.String({ description: "Optional updated failure target lane id." })),
  });
}

function workflowSchemaDescription(tool: OrchestraToolDefinition) {
  return `${tool.description} Requires permission: ${tool.requiredPermission}.`;
}

const SAFE_PROJECT_SECRET_COMMANDS = new Set([
  "list_project_secrets",
  "search_project_secrets",
  "get_project_secret",
  "add_project_secret",
  "update_project_secret",
  "delete_project_secret",
]);

function projectSecretScopeSchema() {
  return {
    projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id. Defaults to the active task project when available." })),
    projectSlug: Type.Optional(Type.String({ description: "Optional Orchestra project slug. Defaults to the active task project when available." })),
    taskId: Type.Optional(Type.String({ description: "Optional task id to resolve the owning project explicitly." })),
  };
}

function requireSourceEnvVar(sourceEnvVar: string) {
  const normalized = sourceEnvVar.trim();
  if (!normalized) {
    throw new Error("sourceEnvVar is required.");
  }
  const value = process.env[normalized];
  if (!value) {
    throw new Error(`Environment variable ${normalized} is not set in this session.`);
  }
  return { normalized, value };
}

async function executeProjectSecretList(params: {
  projectId?: string;
  projectSlug?: string;
  taskId?: string;
  query?: string;
  secretKey?: string;
  valueState?: string;
  hasDescription?: boolean;
}) {
  const payload = {
    projectId: params.projectId,
    projectSlug: params.projectSlug,
    taskId: params.taskId,
    query: params.query,
    secretKey: params.secretKey,
    valueState: params.valueState,
    hasDescription: params.hasDescription,
  };
  const result = await invokeBridge("list_project_secrets", payload);
  return { payload, result };
}

async function executeProjectSecretSearch(params: {
  projectId?: string;
  projectSlug?: string;
  taskId?: string;
  query?: string;
  secretKey?: string;
  valueState?: string;
  hasDescription?: boolean;
}) {
  const payload = {
    projectId: params.projectId,
    projectSlug: params.projectSlug,
    taskId: params.taskId,
    query: params.query,
    secretKey: params.secretKey,
    valueState: params.valueState,
    hasDescription: params.hasDescription,
  };
  const result = await invokeBridge("search_project_secrets", payload);
  return { payload, result };
}

async function executeProjectSecretLoad(params: { secretKey: string; targetEnvVar?: string; projectId?: string; projectSlug?: string; taskId?: string }) {
  const payload = {
    projectId: params.projectId,
    projectSlug: params.projectSlug,
    taskId: params.taskId,
    secretKey: params.secretKey,
  };
  const result = await invokeBridge("get_project_secret", payload) as { projectSlug?: string | null; secretKey?: string | null; value?: string | null };
  const targetEnvVar = (params.targetEnvVar?.trim() || params.secretKey.trim()).toUpperCase();
  if (!result?.value) {
    throw new Error(`Project secret ${params.secretKey} did not return a value.`);
  }
  process.env[targetEnvVar] = result.value;
  return {
    payload: { ...payload, targetEnvVar },
    response: {
      projectSlug: result.projectSlug ?? params.projectSlug ?? null,
      secretKey: result.secretKey ?? params.secretKey,
      targetEnvVar,
      loaded: true,
    },
  };
}

async function executeProjectSecretWrite(
  command: "add_project_secret" | "update_project_secret",
  params: {
    secretKey: string;
    sourceEnvVar: string;
    description?: string;
    projectId?: string;
    projectSlug?: string;
    taskId?: string;
  },
) {
  const { normalized, value } = requireSourceEnvVar(params.sourceEnvVar);
  const payload = {
    projectId: params.projectId,
    projectSlug: params.projectSlug,
    taskId: params.taskId,
    secretKey: params.secretKey,
    description: params.description,
    value,
  };
  const result = await invokeBridge(command, payload);
  return {
    payload: {
      projectId: params.projectId,
      projectSlug: params.projectSlug,
      taskId: params.taskId,
      secretKey: params.secretKey,
      description: params.description,
      sourceEnvVar: normalized,
    },
    result,
  };
}

async function executeProjectSecretDelete(params: { secretKey: string; projectId?: string; projectSlug?: string; taskId?: string }) {
  const payload = {
    projectId: params.projectId,
    projectSlug: params.projectSlug,
    taskId: params.taskId,
    secretKey: params.secretKey,
  };
  const result = await invokeBridge("delete_project_secret", payload);
  return { payload, result };
}

async function runSafeProjectSecretCommandForUi(command: string, payload: Record<string, unknown>) {
  if (command === "list_project_secrets") {
    const { result } = await executeProjectSecretList(payload as { projectId?: string; projectSlug?: string; taskId?: string; query?: string; secretKey?: string; valueState?: string; hasDescription?: boolean });
    return JSON.stringify(result, null, 2);
  }
  if (command === "search_project_secrets") {
    const { result } = await executeProjectSecretSearch(payload as { projectId?: string; projectSlug?: string; taskId?: string; query?: string; secretKey?: string; valueState?: string; hasDescription?: boolean });
    return JSON.stringify(result, null, 2);
  }
  if (command === "get_project_secret") {
    const { response } = await executeProjectSecretLoad(payload as { secretKey: string; targetEnvVar?: string; projectId?: string; projectSlug?: string; taskId?: string });
    return `Loaded ${response.secretKey} into env var ${response.targetEnvVar} for this session.`;
  }
  if (command === "add_project_secret" || command === "update_project_secret") {
    const { payload: safePayload, result } = await executeProjectSecretWrite(
      command,
      payload as { secretKey: string; sourceEnvVar: string; description?: string; projectId?: string; projectSlug?: string; taskId?: string },
    );
    return JSON.stringify({ ok: true, command, payload: safePayload, result }, null, 2);
  }
  if (command === "delete_project_secret") {
    const { result } = await executeProjectSecretDelete(payload as { secretKey: string; projectId?: string; projectSlug?: string; taskId?: string });
    return JSON.stringify(result, null, 2);
  }
  throw new Error(`Unsupported safe project secret command: ${command}`);
}

function noteLocationSchema(description: string, pathDescription: string) {
  return Type.Object({
    scope: Type.String({ description: 'Note scope: project or repository.' }),
    repositoryId: Type.Optional(Type.String({ description: 'Required when scope is repository.' })),
    path: Type.String({ description: pathDescription }),
  }, {
    description,
  });
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

  if (tool.name === "list_project_secrets") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Returns metadata only; secret values are never included.`,
      parameters: Type.Object({
        ...projectSecretScopeSchema(),
        query: Type.Optional(Type.String({ description: "Optional substring query matched against metadata such as secretKey, description, and valueState." })),
        secretKey: Type.Optional(Type.String({ description: "Optional exact secret key filter." })),
        valueState: Type.Optional(Type.String({ description: "Optional exact value state filter such as ready, missing_value, store_locked, or store_error." })),
        hasDescription: Type.Optional(Type.Boolean({ description: "Optional description-presence filter." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string; projectSlug?: string; taskId?: string; query?: string; secretKey?: string; valueState?: string; hasDescription?: boolean }) {
        const { payload, result } = await executeProjectSecretList(params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "search_project_secrets") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Searches metadata only; secret values are never included.`,
      parameters: Type.Object({
        ...projectSecretScopeSchema(),
        query: Type.Optional(Type.String({ description: "Optional substring query matched against metadata such as secretKey, description, and valueState." })),
        secretKey: Type.Optional(Type.String({ description: "Optional exact secret key filter." })),
        valueState: Type.Optional(Type.String({ description: "Optional exact value state filter such as ready, missing_value, store_locked, or store_error." })),
        hasDescription: Type.Optional(Type.Boolean({ description: "Optional description-presence filter." })),
      }),
      async execute(_toolCallId: string, params: { projectId?: string; projectSlug?: string; taskId?: string; query?: string; secretKey?: string; valueState?: string; hasDescription?: boolean }) {
        const { payload, result } = await executeProjectSecretSearch(params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_project_secret") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Loads the secret into this session's environment instead of returning the raw value.`,
      parameters: Type.Object({
        ...projectSecretScopeSchema(),
        secretKey: Type.String({ description: "Project secret key to load." }),
        targetEnvVar: Type.Optional(Type.String({ description: "Optional env var name to populate for this session. Defaults to secretKey." })),
      }),
      async execute(_toolCallId: string, params: { secretKey: string; targetEnvVar?: string; projectId?: string; projectSlug?: string; taskId?: string }) {
        const { payload, response } = await executeProjectSecretLoad(params);
        return {
          content: [{ type: "text" as const, text: `Loaded ${response.secretKey} into env var ${response.targetEnvVar} for this session.` }],
          details: { command: tool.name, payload, result: response },
        };
      },
    };
  }

  if (["add_project_secret", "update_project_secret"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Reads the secret value from an existing session env var so the raw value is not passed in tool arguments or output.`,
      parameters: Type.Object({
        ...projectSecretScopeSchema(),
        secretKey: Type.String({ description: "Project secret key to create or update." }),
        description: Type.Optional(Type.String({ description: "Optional human-readable description." })),
        sourceEnvVar: Type.String({ description: "Existing env var name whose current value should be stored." }),
      }),
      async execute(_toolCallId: string, params: { secretKey: string; description?: string; sourceEnvVar: string; projectId?: string; projectSlug?: string; taskId?: string }) {
        const { payload, result } = await executeProjectSecretWrite(tool.name as "add_project_secret" | "update_project_secret", params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "delete_project_secret") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Deletes the stored secret value and metadata for the target project secret.`,
      parameters: Type.Object({
        ...projectSecretScopeSchema(),
        secretKey: Type.String({ description: "Project secret key to delete." }),
      }),
      async execute(_toolCallId: string, params: { secretKey: string; projectId?: string; projectSlug?: string; taskId?: string }) {
        const { payload, result } = await executeProjectSecretDelete(params);
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

  if (tool.name === "get_workflow_delete_impact") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to inspect." }),
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

  if (tool.name === "delete_workflow") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: workflowSchemaDescription(tool) + " Provide workflowId.",
      parameters: Type.Object({
        workflowId: Type.String({ description: "Workflow id to delete." }),
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

  if (tool.name === "list_notes") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId to list the Project root first and repository note roots after it.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Canonical Orchestra project id, e.g. project-123." }),
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

  if (tool.name === "get_note") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId plus the note location inside docs/.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Canonical Orchestra project id, e.g. project-123." }),
        location: noteLocationSchema(
          'Note location relative to docs/.',
          'Markdown file path relative to docs/, e.g. architecture/plan.md.',
        ),
      }),
      async execute(_toolCallId: string, params: { projectId: string; location: { scope: string; repositoryId?: string; path: string } }) {
        const payload = { projectId: params.projectId, location: params.location };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_note") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId, location, and markdown. This command creates the note if it does not exist yet.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Canonical Orchestra project id, e.g. project-123." }),
        location: noteLocationSchema(
          'Destination note location relative to docs/.',
          'Markdown file path relative to docs/, e.g. architecture/plan.md.',
        ),
        markdown: Type.String({ description: 'Full markdown body to write into the note.' }),
      }),
      async execute(_toolCallId: string, params: { projectId: string; location: { scope: string; repositoryId?: string; path: string }; markdown: string }) {
        const payload = { projectId: params.projectId, location: params.location, markdown: params.markdown };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "delete_note") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId plus the note location to remove.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Canonical Orchestra project id, e.g. project-123." }),
        location: noteLocationSchema(
          'Note location to delete.',
          'Markdown file path relative to docs/, e.g. architecture/plan.md.',
        ),
      }),
      async execute(_toolCallId: string, params: { projectId: string; location: { scope: string; repositoryId?: string; path: string } }) {
        const payload = { projectId: params.projectId, location: params.location };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["copy_note", "move_note"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide projectId plus full source and destination note locations so cross-scope note operations work naturally.`,
      parameters: Type.Object({
        projectId: Type.String({ description: "Canonical Orchestra project id, e.g. project-123." }),
        source: noteLocationSchema(
          'Source note location relative to docs/.',
          'Existing markdown file path relative to docs/, e.g. architecture/plan.md.',
        ),
        destination: noteLocationSchema(
          'Destination note location relative to docs/.',
          'Target markdown file path relative to docs/, e.g. docs/archive/plan-copy.md.',
        ),
      }),
      async execute(_toolCallId: string, params: { projectId: string; source: { scope: string; repositoryId?: string; path: string }; destination: { scope: string; repositoryId?: string; path: string } }) {
        const payload = {
          projectId: params.projectId,
          source: params.source,
          destination: params.destination,
        };
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
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional projectId, includeArchived, tag filters, and sort controls to scope the task list.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope the task list." })),
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived tasks should be included." })),
        tags: Type.Optional(Type.Array(Type.String({ description: "Exact task tag filter value." }))),
        tagMatch: Type.Optional(Type.String({ description: "How multiple requested tags should match: all or any." })),
        sortBy: Type.Optional(Type.String({ description: "Task sort field such as updatedAt, createdAt, priority, number, title, or tags." })),
        sortDirection: Type.Optional(Type.String({ description: "Task sort direction: asc or desc." })),
      }),
      async execute(
        _toolCallId: string,
        params: {
          projectId?: string;
          includeArchived?: boolean;
          tags?: string[];
          tagMatch?: string;
          sortBy?: string;
          sortDirection?: string;
        },
      ) {
        const payload = {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
          ...(params.tags !== undefined ? { tags: params.tags } : {}),
          ...(params.tagMatch !== undefined ? { tagMatch: params.tagMatch } : {}),
          ...(params.sortBy !== undefined ? { sortBy: params.sortBy } : {}),
          ...(params.sortDirection !== undefined ? { sortDirection: params.sortDirection } : {}),
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
        tags: Type.Optional(Type.Array(Type.String({ description: "Canonical task tag value." }))),
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

  if (tool.name === "update_task") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId plus task fields to update.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
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
        tags: Type.Optional(Type.Array(Type.String({ description: "Canonical task tag value." }))),
        whipMaxAttempts: Type.Optional(Type.Number({ description: "Optional maximum whip count for the task lane." })),
        archived: Type.Optional(Type.Boolean({ description: "Whether the task should be archived." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string } & TaskInputParams) {
        const payload = {
          taskId: params.taskId,
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

  if (tool.name === "list_agents") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional projectId and includeArchived to scope the agent list.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id. Global agents are still included when they apply." })),
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived agents should be included." })),
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

  if (["get_agent", "get_agent_memory_info", "archive_agent", "get_agent_permissions"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide agentId.`,
      parameters: Type.Object({
        agentId: Type.String({ description: "Canonical Orchestra agent id, e.g. agent-123" }),
      }),
      async execute(_toolCallId: string, params: { agentId: string }) {
        const payload = { agentId: params.agentId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_agent") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide the agent definition inside a top-level input object.`,
      helpNotes: [
        'The agent definition must be wrapped inside the top-level input property.',
        camelCaseInputNote('agent'),
        'If you pass name, systemPrompt, roleId, or other agent fields at the top level instead of inside input, the command will fail.',
      ],
      helpExamples: [
        {
          input: {
            name: 'Planner',
            description: 'Creates implementation plans for new work.',
            systemPrompt: 'You are a planning specialist.',
            scope: 'global',
            thinkingLevel: 'medium',
            policyIds: ['policy-plan'],
            directPermissions: ['tasks.read'],
          },
        },
        {
          input: {
            name: 'Project Developer',
            scope: 'project',
            projectId: 'project-123',
            provider: 'openai',
            model: 'gpt-5',
            roleId: 'role-123',
          },
        },
      ],
      parameters: Type.Object({
        input: agentInputSchema(),
      }),
      async execute(_toolCallId: string, params: { input: AgentInputParams }) {
        const payload = { input: buildAgentInput(params.input) };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_agent") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide agentId plus the updated agent definition inside input.`,
      helpNotes: [
        'The updated agent definition must be wrapped inside the top-level input property.',
        camelCaseInputNote('agent'),
      ],
      helpExamples: [
        {
          agentId: 'agent-123',
          input: {
            name: 'Planner',
            scope: 'global',
            thinkingLevel: 'high',
            directPermissions: ['tasks.read', 'tasks.comment'],
          },
        },
      ],
      parameters: Type.Object({
        agentId: Type.String({ description: "Canonical Orchestra agent id, e.g. agent-123" }),
        input: agentInputSchema(),
      }),
      async execute(_toolCallId: string, params: { agentId: string; input: AgentInputParams }) {
        const payload = {
          agentId: params.agentId,
          input: buildAgentInput(params.input),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_roles") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional includeArchived to include archived roles.`,
      parameters: Type.Object({
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived roles should be included." })),
      }),
      async execute(_toolCallId: string, params: { includeArchived?: boolean }) {
        const payload = params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {};
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["get_role", "archive_role", "get_role_operations", "get_role_permissions"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide roleId.`,
      parameters: Type.Object({
        roleId: Type.String({ description: "Canonical Orchestra role id, e.g. role-123" }),
      }),
      async execute(_toolCallId: string, params: { roleId: string }) {
        const payload = { roleId: params.roleId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_role_operations") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional includeArchived to include archived roles in the operational snapshot.`,
      parameters: Type.Object({
        includeArchived: Type.Optional(Type.Boolean({ description: "Whether archived roles should be included." })),
      }),
      async execute(_toolCallId: string, params: { includeArchived?: boolean }) {
        const payload = params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {};
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_role") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide the role definition inside a top-level input object.`,
      helpNotes: [
        'The role definition must be wrapped inside the top-level input property.',
        camelCaseInputNote('role'),
      ],
      helpExamples: [
        {
          input: {
            name: 'Senior Developer',
            description: 'Implements planned changes.',
            capacity: 2,
            thinkingLevel: 'medium',
            policyIds: ['policy-dev'],
            directPermissions: ['tasks.read', 'tasks.update'],
          },
        },
      ],
      parameters: Type.Object({
        input: roleInputSchema(),
      }),
      async execute(_toolCallId: string, params: { input: RoleInputParams }) {
        const payload = { input: buildRoleInput(params.input) };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "update_role") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide roleId plus the updated role definition inside input.`,
      helpNotes: [
        'The updated role definition must be wrapped inside the top-level input property.',
        camelCaseInputNote('role'),
      ],
      helpExamples: [
        {
          roleId: 'role-123',
          input: {
            name: 'Senior Developer',
            capacity: 3,
            thinkingLevel: 'high',
          },
        },
      ],
      parameters: Type.Object({
        roleId: Type.String({ description: "Canonical Orchestra role id, e.g. role-123" }),
        input: roleInputSchema(),
      }),
      async execute(_toolCallId: string, params: { roleId: string; input: RoleInputParams }) {
        const payload = {
          roleId: params.roleId,
          input: buildRoleInput(params.input),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "enqueue_role_work") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide the queued work definition inside a top-level input object.`,
      helpNotes: [camelCaseInputNote('role queue entry')],
      helpExamples: [
        {
          input: {
            roleId: 'role-123',
            sourceType: 'task',
            sourceTaskId: 'task-123',
            title: 'Investigate failing tests',
            summary: 'Reproduce the failure and propose a fix.',
          },
        },
      ],
      parameters: Type.Object({
        input: roleQueueEntrySchema(),
      }),
      async execute(_toolCallId: string, params: { input: RoleQueueEntryParams }) {
        const payload = { input: buildRoleQueueEntryInput(params.input) };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["get_task", "get_task_context", "get_task_repositories", "list_task_comments", "get_unread_task_comments", "list_task_file_references", "list_task_todos", "list_task_repositories"].includes(tool.name)) {
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

  if (tool.name === "remind_me") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide a reminder message plus exactly one of delaySeconds or delayMinutes.`,
      helpExamples: [{ message: 'Check the CI build status', delayMinutes: 10 }],
      parameters: reminderInputSchema(),
      async execute(_toolCallId: string, params: ReminderParams) {
        const payload = buildReminderInput(params);
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "create_subtask") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide parentTaskId plus the new task definition inside input.`,
      helpNotes: [
        'The child task definition must be wrapped inside the top-level input property.',
        camelCaseInputNote('task'),
      ],
      helpExamples: [
        {
          parentTaskId: 'task-123',
          input: {
            title: 'Write regression coverage',
            description: 'Add tests for the failing edge case.',
            type: 'task',
            priority: 'P2',
          },
        },
      ],
      parameters: Type.Object({
        parentTaskId: Type.String({ description: "Parent task id that should own the new subtask." }),
        input: Type.Object({
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
          tags: Type.Optional(Type.Array(Type.String({ description: "Canonical task tag value." }))),
          whipMaxAttempts: Type.Optional(Type.Number({ description: "Optional maximum whip count for the task lane." })),
          archived: Type.Optional(Type.Boolean({ description: "Whether the task should be created archived." })),
        }, {
          description: 'Wrapped subtask definition. Put the child task fields inside top-level input, e.g. {"parentTaskId":"task-123","input":{...}}.',
        }),
      }),
      async execute(_toolCallId: string, params: { parentTaskId: string; input: TaskInputParams }) {
        const payload = {
          parentTaskId: params.parentTaskId,
          input: buildTaskInput(params.input),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["get_task_comment_delete_impact", "delete_task_comment"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide commentId.`,
      parameters: Type.Object({
        commentId: Type.String({ description: "Task comment id to inspect or delete." }),
      }),
      async execute(_toolCallId: string, params: { commentId: string }) {
        const payload = { commentId: params.commentId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["dispatch_task_lane", "approve_task_review"].includes(tool.name)) {
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

  if (["complete_lane_as_success", "complete_lane_as_failure", "request_user_intervention", "mark_task_needs_work", "resume_task_lane", "pause_task_lane", "stop_task_activity"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and optionally notes.`,
      helpExamples: transitionExamples(),
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        notes: Type.Optional(Type.String({ description: "Optional notes describing the outcome, status, or reason for the transition." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string; notes?: string }) {
        const payload = {
          taskId: params.taskId,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "stop_session_runtime") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide sessionId and optionally notes.`,
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session id to stop." }),
        notes: Type.Optional(Type.String({ description: "Optional reason for stopping the session runtime." })),
      }),
      async execute(_toolCallId: string, params: { sessionId: string; notes?: string }) {
        const payload = {
          sessionId: params.sessionId,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "add_task_dependency") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide blockerTaskId and blockedTaskId.`,
      helpExamples: [{ blockerTaskId: 'task-1', blockedTaskId: 'task-2' }],
      parameters: Type.Object({
        blockerTaskId: Type.String({ description: "Task id that must be completed first." }),
        blockedTaskId: Type.String({ description: "Task id that is blocked by blockerTaskId." }),
      }),
      async execute(_toolCallId: string, params: { blockerTaskId: string; blockedTaskId: string }) {
        const payload = {
          blockerTaskId: params.blockerTaskId,
          blockedTaskId: params.blockedTaskId,
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "remove_task_dependency") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide dependencyId.`,
      parameters: Type.Object({
        dependencyId: Type.String({ description: "Task dependency id to remove." }),
      }),
      async execute(_toolCallId: string, params: { dependencyId: string }) {
        const payload = { dependencyId: params.dependencyId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "add_task_attachment") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId plus the attachment definition inside input.`,
      helpNotes: [
        'The attachment payload must be wrapped inside the top-level input property.',
        camelCaseInputNote('task attachment'),
        'Prefer input.filePath for readable files that already exist on disk in this session. Relative filePath values resolve from the current session working directory.',
        'Use input.base64Data only when the bytes are already in memory or generated outside the local filesystem. In base64Data mode, input.fileName and input.mediaType are required.',
      ],
      helpExamples: [
        {
          taskId: 'task-123',
          input: {
            filePath: './artifacts/ci-output.log',
            caption: 'CI failure excerpt',
          },
        },
        {
          taskId: 'task-123',
          input: {
            fileName: 'error.log',
            mediaType: 'text/plain',
            base64Data: 'ZXhhbXBsZSBsb2c=',
            caption: 'CI failure excerpt',
          },
        },
      ],
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        input: taskAttachmentSchema(),
      }),
      async execute(_toolCallId: string, params: { taskId: string; input: TaskAttachmentParams }) {
        const attachmentInput = await buildTaskAttachmentInput(params.input);
        const payload = {
          taskId: params.taskId,
          input: attachmentInput.bridgeInput,
        };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, attachmentInput: attachmentInput.auditInput, result },
        };
      },
    };
  }

  if (tool.name === "remove_task_attachment") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide attachmentId.`,
      parameters: Type.Object({
        attachmentId: Type.String({ description: "Task attachment id to remove." }),
      }),
      async execute(_toolCallId: string, params: { attachmentId: string }) {
        const payload = { attachmentId: params.attachmentId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "list_policies") {
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

  if (tool.name === "get_policy") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide policyId.`,
      parameters: Type.Object({
        policyId: Type.String({ description: "Canonical Orchestra policy id, e.g. policy-123" }),
      }),
      async execute(_toolCallId: string, params: { policyId: string }) {
        const payload = { policyId: params.policyId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_role_instance_permissions") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide roleInstanceId.`,
      parameters: Type.Object({
        roleInstanceId: Type.String({ description: "Role instance id to inspect." }),
      }),
      async execute(_toolCallId: string, params: { roleInstanceId: string }) {
        const payload = { roleInstanceId: params.roleInstanceId };
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
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId, author, message, and optionally interruptAgent, parentCommentId, and anchor.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        author: Type.String({ description: "Comment author name to record on the task." }),
        message: Type.String({ description: "Durable task comment text describing what happened and why." }),
        interruptAgent: Type.Optional(Type.Boolean({ description: "Whether this comment should interrupt an active worker immediately." })),
        parentCommentId: Type.Optional(Type.String({ description: "Existing top-level task comment id to reply to." })),
        anchor: Type.Optional(Type.Any({ description: "Optional file or DOM anchor payload for the task comment." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string; author: string; message: string; interruptAgent?: boolean; parentCommentId?: string; anchor?: Record<string, unknown> }) {
        const payload = {
          taskId: params.taskId,
          input: {
            author: params.author,
            message: params.message,
            interruptAgent: params.interruptAgent ?? false,
            parentCommentId: params.parentCommentId ?? null,
            ...(params.anchor ? { anchor: params.anchor } : {}),
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

  if (["get_task_context", "get_task_repositories", "list_task_comments", "get_unread_task_comments", "list_task_file_references", "list_task_todos", "show_task_browser", "get_task_browser_state"].includes(tool.name)) {
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

  if (tool.name === "navigate_task_browser") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and url.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        url: Type.String({ description: "Target http(s) URL for the task browser surface." }),
      }),
      async execute(_toolCallId: string, params: { taskId: string; url: string }) {
        const payload = { taskId: params.taskId, url: params.url };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "set_task_browser_inspect_mode") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and enabled.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        enabled: Type.Boolean({ description: "Whether inspect mode should be enabled." }),
      }),
      async execute(_toolCallId: string, params: { taskId: string; enabled: boolean }) {
        const payload = { taskId: params.taskId, enabled: params.enabled };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "reveal_task_browser_dom_anchor") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId and anchor.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        anchor: Type.Object({
          browserSessionId: Type.String({ description: "Task browser session id." }),
          url: Type.String({ description: "Page URL captured for the DOM anchor." }),
          pageTitle: Type.Optional(Type.String({ description: "Optional page title captured for the DOM anchor." })),
          domRevision: Type.Number({ description: "DOM revision captured when the anchor was selected." }),
          locator: Type.Object({
            cssPath: Type.Optional(Type.String({ description: "Optional CSS locator path." })),
            xpath: Type.Optional(Type.String({ description: "Optional XPath locator." })),
            role: Type.Optional(Type.String({ description: "Optional ARIA role value." })),
            accessibleName: Type.Optional(Type.String({ description: "Optional accessible-name hint." })),
            textSnippet: Type.Optional(Type.String({ description: "Optional text snippet hint." })),
            testId: Type.Optional(Type.String({ description: "Optional data-testid hint." })),
            ordinalPath: Type.Optional(Type.Array(Type.Object({
              tag: Type.String({ description: "Tag name segment." }),
              index: Type.Number({ description: "Zero-based sibling index for the tag segment." }),
            }))),
          }),
          snapshot: Type.Object({
            tagName: Type.String({ description: "Selected DOM element tag name." }),
            id: Type.Optional(Type.String({ description: "Optional element id." })),
            classList: Type.Optional(Type.Array(Type.String({ description: "Captured element classes." }))),
            textPreview: Type.Optional(Type.String({ description: "Optional text preview." })),
            attributes: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Captured DOM attribute map." })),
            outerHtmlSnippet: Type.Optional(Type.String({ description: "Optional outerHTML snippet." })),
          }),
        }),
      }),
      async execute(_toolCallId: string, params: { taskId: string; anchor: Record<string, unknown> }) {
        const payload = { taskId: params.taskId, anchor: { kind: "dom", ...params.anchor } };
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
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide description and the target laneId; taskId remains optional in an active worker session. Worker-owned sessions may target their current lane or directly connected workflow handoff lanes only.`,
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "Optional canonical Orchestra task id. Omit in an active worker session to use the current task." })),
        laneId: Type.String({ description: "Required workflow lane id that should own the todo." }),
        description: Type.String({ description: "Todo description to track on the task." }),
      }),
      async execute(_toolCallId: string, params: { taskId?: string; laneId: string; description: string }) {
        const payload = {
          ...(params.taskId ? { taskId: params.taskId } : {}),
          input: {
            laneId: params.laneId,
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

  if (tool.name === "reassign_task_to_lane") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide taskId, laneId, and optionally notes describing why the task is being moved.`,
      parameters: Type.Object({
        taskId: Type.String({ description: "Canonical Orchestra task id, e.g. task-123" }),
        laneId: Type.String({ description: "Workflow lane id that should own the task next." }),
        notes: Type.Optional(Type.String({ description: "Optional re-lane notes describing the failure or redirect." })),
      }),
      async execute(_toolCallId: string, params: { taskId: string; laneId: string; notes?: string }) {
        const payload = {
          taskId: params.taskId,
          laneId: params.laneId,
          ...(params.notes !== undefined ? { notes: params.notes } : {}),
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

  if (tool.name === "list_sessions") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional project/session/query/task/worker filters plus hidden, dismissed, legacy-diagnostic catalog/list-entry state, file state, and limit controls.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope the session inventory." })),
        projectSlug: Type.Optional(Type.String({ description: "Optional project slug to scope the session inventory." })),
        sessionIds: Type.Optional(Type.Array(Type.String({ description: "Exact session id to include." }))),
        query: Type.Optional(Type.String({ description: "Optional title/id/task/worker substring query." })),
        status: Type.Optional(Type.String({ description: "Optional session status filter such as active, idle, closed, or unknown." })),
        taskId: Type.Optional(Type.String({ description: "Optional linked task id filter." })),
        taskNumber: Type.Optional(Type.String({ description: "Optional linked task number filter, e.g. ORC-176." })),
        workerType: Type.Optional(Type.String({ description: "Optional worker type filter such as role or agent." })),
        workerName: Type.Optional(Type.String({ description: "Optional exact worker name filter." })),
        hidden: Type.Optional(Type.Boolean({ description: "Whether to include only hidden or only visible sessions." })),
        dismissed: Type.Optional(Type.Boolean({ description: "Whether to include only canonically user-dismissed or non-dismissed sessions." })),
        catalogPresent: Type.Optional(Type.Boolean({ description: "Compatibility alias for legacyCatalogPresent. Filters on whether a legacy session_catalog row exists." })),
        legacyCatalogPresent: Type.Optional(Type.Boolean({ description: "Admin-only drift filter for whether a legacy session_catalog row exists." })),
        legacyListEntryPresent: Type.Optional(Type.Boolean({ description: "Admin-only drift filter for whether a legacy session_list_entries row exists." })),
        fileExists: Type.Optional(Type.Boolean({ description: "Filter on whether the transcript file exists." })),
        limit: Type.Optional(Type.Number({ description: "Optional maximum number of sessions to return." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const payload = { ...params };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "get_session_diagnostics") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide sessionId to inspect canonical, transcript, legacy catalog/list-entry, run-origin, and runtime diagnostics.`,
      parameters: Type.Object({
        sessionId: Type.String({ description: "Canonical Orchestra session id to inspect." }),
      }),
      async execute(_toolCallId: string, params: { sessionId: string }) {
        const payload = { sessionId: params.sessionId };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (["hide_sessions", "restore_sessions", "delete_sessions"].includes(tool.name)) {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide explicit session filters. Legacy catalog/list-entry filters are admin-only diagnostics. Destructive execution defaults to dryRun=true and requires confirm=true when dryRun=false. delete_sessions also supports stopActiveRuntimes and may additionally require sessions.stop.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope the target sessions." })),
        projectSlug: Type.Optional(Type.String({ description: "Optional project slug to scope the target sessions." })),
        sessionIds: Type.Optional(Type.Array(Type.String({ description: "Exact session id to target." }))),
        query: Type.Optional(Type.String({ description: "Optional title/id/task/worker substring query." })),
        status: Type.Optional(Type.String({ description: "Optional session status filter." })),
        taskId: Type.Optional(Type.String({ description: "Optional linked task id filter." })),
        taskNumber: Type.Optional(Type.String({ description: "Optional linked task number filter." })),
        workerType: Type.Optional(Type.String({ description: "Optional worker type filter." })),
        workerName: Type.Optional(Type.String({ description: "Optional exact worker name filter." })),
        hidden: Type.Optional(Type.Boolean({ description: "Optional hidden-state filter." })),
        dismissed: Type.Optional(Type.Boolean({ description: "Optional canonical user-dismissed-state filter." })),
        catalogPresent: Type.Optional(Type.Boolean({ description: "Compatibility alias for legacyCatalogPresent." })),
        legacyCatalogPresent: Type.Optional(Type.Boolean({ description: "Optional admin-only legacy session_catalog presence filter." })),
        legacyListEntryPresent: Type.Optional(Type.Boolean({ description: "Optional admin-only legacy session_list_entries presence filter." })),
        fileExists: Type.Optional(Type.Boolean({ description: "Optional transcript file existence filter." })),
        limit: Type.Optional(Type.Number({ description: "Optional maximum number of sessions to match." })),
        reason: Type.Optional(Type.String({ description: "Optional hide reason. hide_sessions defaults to user_dismissed when omitted." })),
        dryRun: Type.Optional(Type.Boolean({ description: "Whether to preview the change without executing it. Defaults to true." })),
        confirm: Type.Optional(Type.Boolean({ description: "Must be true when dryRun is false." })),
        stopActiveRuntimes: Type.Optional(Type.Boolean({ description: "For delete_sessions only: stop active runtimes before deleting them. Requires sessions.stop when true." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const payload = { ...params };
        const result = await invokeBridge(tool.name, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: { command: tool.name, payload, result },
        };
      },
    };
  }

  if (tool.name === "reconcile_sessions") {
    return {
      name: tool.name,
      label: `Orchestra · ${tool.name}`,
      description: `${tool.description} Requires permission: ${tool.requiredPermission}. Provide optional project/session/query filters to inspect or repair canonical/transcript/legacy drift. Legacy catalog/list-entry filters are admin-only diagnostics. Execution defaults to dryRun=true and requires confirm=true when dryRun=false.`,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "Optional Orchestra project id to scope reconciliation." })),
        projectSlug: Type.Optional(Type.String({ description: "Optional project slug to scope reconciliation." })),
        sessionIds: Type.Optional(Type.Array(Type.String({ description: "Optional exact session ids to reconcile." }))),
        query: Type.Optional(Type.String({ description: "Optional title/id/task/worker substring query." })),
        status: Type.Optional(Type.String({ description: "Optional session status filter." })),
        taskId: Type.Optional(Type.String({ description: "Optional linked task id filter." })),
        taskNumber: Type.Optional(Type.String({ description: "Optional linked task number filter." })),
        workerType: Type.Optional(Type.String({ description: "Optional worker type filter." })),
        workerName: Type.Optional(Type.String({ description: "Optional exact worker name filter." })),
        hidden: Type.Optional(Type.Boolean({ description: "Optional hidden-state filter." })),
        dismissed: Type.Optional(Type.Boolean({ description: "Optional canonical user-dismissed-state filter." })),
        catalogPresent: Type.Optional(Type.Boolean({ description: "Compatibility alias for legacyCatalogPresent." })),
        legacyCatalogPresent: Type.Optional(Type.Boolean({ description: "Optional admin-only legacy session_catalog presence filter." })),
        legacyListEntryPresent: Type.Optional(Type.Boolean({ description: "Optional admin-only legacy session_list_entries presence filter." })),
        fileExists: Type.Optional(Type.Boolean({ description: "Optional transcript file existence filter." })),
        limit: Type.Optional(Type.Number({ description: "Optional maximum number of sessions to inspect." })),
        dryRun: Type.Optional(Type.Boolean({ description: "Whether to preview the reconciliation without executing it. Defaults to true." })),
        confirm: Type.Optional(Type.Boolean({ description: "Must be true when dryRun is false." })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const payload = { ...params };
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
      if (SAFE_PROJECT_SECRET_COMMANDS.has(command)) {
        const message = await runSafeProjectSecretCommandForUi(command, payload as Record<string, unknown>);
        ctx.ui.notify(message, "info");
        return;
      }
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
