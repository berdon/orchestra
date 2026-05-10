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
const logPath = process.env.ORCHESTRA_FAKE_PI_STALE_PROMPT_LOG_PATH || "";
const sessionId = path.basename(sessionFile, path.extname(sessionFile));
const statePath = `${sessionFile}.stale-prompt-state.json`;
const defaultModel = {
  id: "fixture-model",
  name: "Stale Prompt Fixture",
  provider: "fixture",
  api: "fixture-rpc",
  reasoning: false,
};

function appendLog(entry) {
  if (!logPath) {
    return;
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId, ...entry })}\n`,
  );
}

function ensureSessionHeader() {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  if (fs.existsSync(sessionFile)) {
    return;
  }
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session_info",
      id: sessionId,
      name: "Fake Pi stale prompt fixture session",
      timestamp: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

function readSessionEntries() {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }
  return fs
    .readFileSync(sessionFile, "utf8")
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

function readState() {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
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
        api: entry.api || defaultModel.api,
        reasoning: Boolean(entry.reasoning),
      };
    }
  }
  return defaultModel;
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

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeAssistantReply(commandType, message) {
  const model = getCurrentModel();
  const now = new Date();
  const later = new Date(now.getTime() + 1);
  const assistantText = `Fixture recovered reply: ${String(message || "")}`;

  appendEntry({
    type: "message",
    id: `user-${Date.now()}`,
    parentId: null,
    timestamp: now.toISOString(),
    message: {
      role: "user",
      content: message,
      timestamp: now.getTime(),
      attachments: [],
    },
  });

  writeResponse({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
  });
  writeResponse({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Fixture recovered reply: ",
      partial: {},
    },
  });
  writeResponse({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: String(message || ""),
      partial: {},
    },
  });

  appendEntry({
    type: "message",
    id: `assistant-${Date.now()}`,
    parentId: null,
    timestamp: later.toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: later.getTime(),
    },
  });

  writeResponse({ type: "agent_end", messages: [] });
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
      data: { models: [defaultModel] },
    });
    return;
  }

  if (command.type === "get_session_stats") {
    const entries = readSessionEntries();
    const userMessages = entries.filter(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    ).length;
    const assistantMessages = entries.filter(
      (entry) => entry.type === "message" && entry.message?.role === "assistant",
    ).length;
    const totalMessages = userMessages + assistantMessages;
    writeResponse({
      id: command.id,
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        sessionFile,
        sessionId,
        userMessages,
        assistantMessages,
        toolCalls: 0,
        toolResults: 0,
        totalMessages,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage:
          totalMessages > 0
            ? { tokens: 1024, contextWindow: 200000, percent: 0.512 }
            : null,
      },
    });
    return;
  }

  if (command.type === "set_model") {
    appendEntry({
      type: "model_change",
      id: `model-${Date.now()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: command.provider,
      modelId: command.modelId,
      modelName: command.modelId,
      api: defaultModel.api,
      reasoning: false,
    });
    writeResponse({
      id: command.id,
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: command.modelId,
        name: command.modelId,
        provider: command.provider,
        api: defaultModel.api,
        reasoning: false,
      },
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
    const state = readState();
    const shouldStall = !state.initialPromptAccepted;
    appendLog({
      branch: shouldStall ? "prompt:stalled" : "prompt:recovered",
      commandType: command.type,
      message: typeof command.message === "string" ? command.message : "",
    });

    writeResponse({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
    });

    if (shouldStall) {
      writeState({
        ...state,
        initialPromptAccepted: true,
        stalledCommandType: command.type,
        stalledMessage: typeof command.message === "string" ? command.message : "",
      });
      return;
    }

    writeAssistantReply(command.type, command.message);
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
