#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
if (sessionIndex === -1 || !args[sessionIndex + 1]) {
  console.error("missing --session");
  process.exit(1);
}

const sessionFile = args[sessionIndex + 1];
const agentDir = process.env.PI_CODING_AGENT_DIR || path.dirname(sessionFile);
const authPath = path.join(agentDir, "auth.json");
const modelsPath = path.join(agentDir, "models.json");
const logPath = process.env.ORCHESTRA_FAKE_PI_MODEL_AUTH_LOG_PATH || "";

function appendLog(entry) {
  if (!logPath) {
    return;
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function ensureSessionHeader() {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  if (fs.existsSync(sessionFile)) {
    return;
  }
  fs.writeFileSync(sessionFile, `${JSON.stringify({
    type: "session_info",
    id: path.basename(sessionFile, path.extname(sessionFile)),
    name: "Fake Pi model-auth fixture session",
    timestamp: new Date().toISOString(),
  })}\n`, "utf8");
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readModels() {
  const parsed = readJsonObject(modelsPath);
  const providers = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
    ? parsed.providers
    : {};
  const models = [];
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const providerModels = providerConfig && typeof providerConfig === "object" && Array.isArray(providerConfig.models)
      ? providerConfig.models
      : [];
    for (const model of providerModels) {
      if (!model || typeof model !== "object") {
        continue;
      }
      models.push({
        id: typeof model.id === "string" ? model.id : "model",
        name: typeof model.name === "string" ? model.name : (typeof model.id === "string" ? model.id : "Model"),
        provider: providerId,
        api: typeof providerConfig.api === "string" ? providerConfig.api : "",
        reasoning: Boolean(model.reasoning),
      });
    }
  }

  if (models.length > 0) {
    return models;
  }

  return [{
    id: "gpt-5.4",
    name: "GPT 5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
    reasoning: true,
  }];
}

function readSessionEntries() {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }
  return fs.readFileSync(sessionFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendEntry(entry) {
  fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function getCurrentModel() {
  const entries = readSessionEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "model_change") {
      return {
        id: entry.modelId,
        name: entry.modelName || entry.modelId,
        provider: entry.provider,
        api: entry.api || "",
        reasoning: Boolean(entry.reasoning),
      };
    }
  }

  return readModels()[0];
}

function getCurrentThinkingLevel() {
  const entries = readSessionEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "thinking_level_change") {
      return entry.thinkingLevel || "off";
    }
  }
  return "off";
}

function resolveAuthFailure(model) {
  if (!model || model.provider !== "openai-codex") {
    return null;
  }

  const auth = readJsonObject(authPath);
  const credential = auth[model.provider];
  if (!credential) {
    return {
      reason: "missing",
      error: "OpenAI Codex missing credential in auth.json",
    };
  }
  if (credential.status === "expired") {
    return {
      reason: "expired",
      error: "OpenAI Codex token expired and must be refreshed",
    };
  }
  if (credential.status === "invalid") {
    return {
      reason: "invalid",
      error: "OpenAI Codex unauthorized (401 invalid credentials)",
    };
  }
  return null;
}

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handleCommand(command) {
  if (!command || typeof command !== "object") {
    return;
  }

  if (command.type === "get_state") {
    writeResponse({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: getCurrentModel(),
        thinkingLevel: getCurrentThinkingLevel(),
      },
    });
    return;
  }

  if (command.type === "get_available_models") {
    writeResponse({
      id: command.id,
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: readModels() },
    });
    return;
  }

  if (command.type === "get_session_stats") {
    const entries = readSessionEntries();
    const userMessages = entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length;
    const assistantMessages = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").length;
    const totalMessages = userMessages + assistantMessages;
    writeResponse({
      id: command.id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        sessionFile,
        sessionId: path.basename(sessionFile, path.extname(sessionFile)),
        userMessages,
        assistantMessages,
        toolCalls: 0,
        toolResults: 0,
        totalMessages,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: totalMessages > 0 ? { tokens: 2048, contextWindow: 200000, percent: 1.024 } : null,
      },
    });
    return;
  }

  if (command.type === "set_model") {
    const model = readModels().find((entry) => entry.provider === command.provider && entry.id === command.modelId) || null;
    appendEntry({
      type: "model_change",
      id: `model-${Date.now()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: command.provider,
      modelId: command.modelId,
      modelName: model?.name || command.modelId,
      api: model?.api || "",
      reasoning: Boolean(model?.reasoning),
    });
    writeResponse({
      id: command.id,
      type: "response",
      command: "set_model",
      success: Boolean(model),
      ...(model ? { data: model } : { error: "Model not found" }),
    });
    return;
  }

  if (command.type === "set_thinking_level") {
    appendEntry({
      type: "thinking_level_change",
      id: `thinking-${Date.now()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      thinkingLevel: command.level || "off",
    });
    writeResponse({
      id: command.id,
      type: "response",
      command: "set_thinking_level",
      success: true,
      data: { level: command.level || "off" },
    });
    return;
  }

  if (command.type === "prompt" || command.type === "follow_up" || command.type === "steer") {
    const model = getCurrentModel();
    const authFailure = resolveAuthFailure(model);
    appendLog({
      branch: authFailure ? `prompt:${authFailure.reason}` : "prompt:success",
      providerId: model?.provider || null,
      modelId: model?.id || null,
      message: typeof command.message === "string" ? command.message : "",
    });

    if (authFailure) {
      writeResponse({
        id: command.id,
        type: "response",
        command: "prompt",
        success: false,
        error: authFailure.error,
      });
      return;
    }

    const now = new Date();
    const later = new Date(now.getTime() + 1);
    appendEntry({
      type: "message",
      id: `user-${Date.now()}`,
      parentId: null,
      timestamp: now.toISOString(),
      message: {
        role: "user",
        content: command.message,
        timestamp: now.getTime(),
        attachments: [],
      },
    });

    writeResponse({ id: command.id, type: "response", command: "prompt", success: true });
    writeResponse({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
    });
    writeResponse({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Fixture reply: ", partial: {} },
    });
    writeResponse({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: String(command.message || ""), partial: {} },
    });

    appendEntry({
      type: "message",
      id: `assistant-${Date.now()}`,
      parentId: null,
      timestamp: later.toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Fixture reply: ${String(command.message || "")}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: later.getTime(),
      },
    });

    writeResponse({ type: "agent_end", messages: [] });
    return;
  }

  writeResponse({
    id: command.id,
    type: "response",
    command: command.type || "unknown",
    success: false,
    error: `Unknown command: ${command.type || "unknown"}`,
  });
}

ensureSessionHeader();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newlineIndex = input.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = input.slice(0, newlineIndex).trim();
    input = input.slice(newlineIndex + 1);
    if (line) {
      handleCommand(JSON.parse(line));
    }
    newlineIndex = input.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
