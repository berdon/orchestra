import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type AuthorizationContext = { actorType: string; actorId: string } | null;
type OrchestraToolDefinition = { name: string; description: string; requiredPermission: string };

function getBridgeConfig() {
  const bridgeUrl = process.env.ORCHESTRA_BRIDGE_URL;
  const token = process.env.ORCHESTRA_BRIDGE_TOKEN;
  const allowedCommandsRaw = process.env.ORCHESTRA_ALLOWED_COMMANDS_JSON;
  const authorizationRaw = process.env.ORCHESTRA_AUTH_CONTEXT_JSON;

  if (!bridgeUrl || !token || !allowedCommandsRaw) {
    return null;
  }

  const allowedCommands = JSON.parse(allowedCommandsRaw) as OrchestraToolDefinition[];
  const authorization = authorizationRaw ? (JSON.parse(authorizationRaw) as AuthorizationContext) : null;
  return { bridgeUrl, token, allowedCommands, authorization };
}

async function invokeBridge(command: string, payload: Record<string, unknown>) {
  const config = getBridgeConfig();
  if (!config) {
    throw new Error("Orchestra bridge is not configured for this session.");
  }

  const response = await fetch(`${config.bridgeUrl}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: config.token,
      command,
      authorization: config.authorization,
      payload,
    }),
  });

  const body = (await response.json()) as { success: boolean; data?: unknown; error?: string };
  if (!body.success) {
    throw new Error(body.error ?? `Orchestra bridge command failed: ${command}`);
  }

  return body.data;
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

export default function orchestraToolsExtension(pi: ExtensionAPI) {
  const config = getBridgeConfig();
  if (!config) {
    return;
  }

  const allowedCommandNames = config.allowedCommands.map((tool) => tool.name);
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
      const payloadText = jsonParts.join(" ").trim();
      const payload = payloadText ? JSON.parse(payloadText) : {};
      const result = await invokeBridge(command, payload as Record<string, unknown>);
      ctx.ui.notify(JSON.stringify(result, null, 2), "info");
    },
  });

  pi.registerTool({
    name: "orchestra_command",
    label: "Orchestra Command",
    description: `Invoke Orchestra backend commands. Allowed commands: help, ${allowedCommandNames.join(", ")}`,
    parameters: Type.Object({
      command: Type.String({ description: `One of: help, ${allowedCommandNames.join(", ")}` }),
      inputJson: Type.Optional(
        Type.String({ description: "Optional JSON object string for command input, e.g. {\"includeArchived\":true}" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const command = typeof params.command === "string" ? params.command : "";
      if (command === "help") {
        const result = resolveHelpResult(config.allowedCommands);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { command, result },
        };
      }
      if (!allowedCommandNames.includes(command)) {
        throw new Error(`Command ${command} is not allowed for this session.`);
      }
      const payload = typeof params.inputJson === "string" && params.inputJson.trim().length > 0
        ? JSON.parse(params.inputJson)
        : {};
      const result = await invokeBridge(command, payload as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { command, result },
      };
    },
  });
}
