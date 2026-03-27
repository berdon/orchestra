import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type AuthorizationContext = { actorType: string; actorId: string } | null;
type OrchestraToolDefinition = { name: string; description: string; requiredPermission: string };

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

function buildAllowedCommandHelp(allowedCommands: OrchestraToolDefinition[]) {
  return allowedCommands
    .map((tool) => `- ${tool.name} (${tool.requiredPermission}) — ${tool.description}`)
    .join("\n");
}

function resolveHelpResult(allowedCommands: OrchestraToolDefinition[]) {
  return {
    commands: allowedCommands,
    helpText: buildAllowedCommandHelp(allowedCommands),
  };
}

export function parseInputJson(inputJson: unknown) {
  if (typeof inputJson !== "string" || inputJson.trim().length === 0) {
    return {};
  }
  return JSON.parse(inputJson) as Record<string, unknown>;
}

export function createBridgeTool(tool: OrchestraToolDefinition) {
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

  if (["get_task_context", "get_task_repositories", "list_task_comments", "get_unread_task_comments", "list_task_file_references"].includes(tool.name)) {
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
        ctx.ui.notify(`Available Orchestra commands:\n${allowedCommandHelp}`, "info");
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
    description: "List Orchestra backend commands available to this session.",
    parameters: Type.Object({}),
    async execute() {
      const result = resolveHelpResult(config.allowedCommands);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { command: "help", result },
      };
    },
  };
  pi.registerTool(helpTool);

  for (const tool of config.allowedCommands) {
    const bridgeTool = createBridgeTool(tool);
    pi.registerTool(bridgeTool);
  }
}
