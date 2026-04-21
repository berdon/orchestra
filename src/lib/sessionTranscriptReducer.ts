import type { JsonValue, SessionActivityState, SessionEvent, SessionRecord, SessionStreamEnvelope } from "../types";

export interface PendingSessionRun {
  runId: string;
  userEvent: SessionEvent;
  assistantEvent?: SessionEvent;
}

export interface SessionTranscriptReduction {
  session: SessionRecord;
  pendingRun?: PendingSessionRun;
  refreshFromBackend?: boolean;
  sessionActionError?: string;
}

function isObject(value: JsonValue | undefined | null): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: JsonValue | undefined | null) {
  return Array.isArray(value) ? value : [];
}

function asString(value: JsonValue | undefined | null) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: JsonValue | undefined | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createClientId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function extractRpcMessageBlocks(message: JsonValue | undefined | null, expectedType: string, valueKey: string) {
  if (!isObject(message)) {
    return "";
  }

  return asArray(message.content)
    .map((block) => {
      if (!isObject(block) || asString(block.type) !== expectedType) {
        return "";
      }
      return asString(block[valueKey]);
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractRpcMessageText(message: JsonValue | undefined | null) {
  return extractRpcMessageBlocks(message, "text", "text");
}

function extractRpcThinkingText(message: JsonValue | undefined | null) {
  return extractRpcMessageBlocks(message, "thinking", "thinking");
}

function getRpcEventType(envelope: SessionStreamEnvelope) {
  return isObject(envelope.event) ? asString(envelope.event.type) : "";
}

function getRpcAssistantDeltaType(envelope: SessionStreamEnvelope) {
  if (!isObject(envelope.event)) {
    return "";
  }

  const delta = envelope.event.assistantMessageEvent;
  return isObject(delta) ? asString(delta.type) : "";
}

function buildPendingAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: `pending-assistant-${runId}`,
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    thinkingText: "",
    runId,
    ...overrides,
  };
}

function buildStreamAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createClientId(`stream-assistant-${runId}`),
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    thinkingText: "",
    runId,
    ...overrides,
  };
}

function hasVisibleAssistantText(event?: SessionEvent) {
  return Boolean(event?.message.trim() && event.message.trim() !== "Running tools…");
}

function formatJsonSummary(value: JsonValue | undefined | null) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (isObject(value) && Array.isArray(value.content)) {
    const extracted = value.content
      .map((block) => {
        if (!isObject(block)) {
          return "";
        }
        return asString(block.text) || asString(block.thinking);
      })
      .filter(Boolean)
      .join("\n\n");

    if (extracted) {
      return extracted;
    }
  }

  return JSON.stringify(value, null, 2);
}

function inferCodeFenceLanguage(value: JsonValue | undefined | null, formatted?: string) {
  if (value === undefined || value === null) {
    return "text";
  }

  const trimmed = (formatted ?? (typeof value === "string" ? value : "")).trim();
  if (!trimmed) {
    return typeof value === "string" ? "text" : "json";
  }

  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // continue
  }

  if (/^<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return "html";
  }

  if (/^#{1,6}\s|```|^[-*+]\s|^\d+\.\s/m.test(trimmed)) {
    return "markdown";
  }

  if (/(^|\n)(\$ |npm |pnpm |yarn |cargo |git |bash |sh )/.test(trimmed)) {
    return "bash";
  }

  if (typeof value !== "string" && !formatted) {
    return "json";
  }

  return "text";
}

function buildCodeFence(value: JsonValue | undefined | null) {
  const formatted = formatJsonSummary(value);
  if (!formatted) {
    return "";
  }

  return `\`\`\`${inferCodeFenceLanguage(value, formatted)}\n${formatted}\n\`\`\``;
}

function summarizeToolArgument(value: JsonValue | undefined | null) {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const normalized = JSON.stringify(value);
    return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
  }
  const normalized = JSON.stringify(value);
  return normalized.length > 48 ? `${normalized.slice(0, 45)}…` : normalized;
}

function formatToolCallLabel(toolName: string, args: JsonValue | undefined | null) {
  const argValues = Array.isArray(args)
    ? args
    : isObject(args)
      ? Object.values(args)
      : args === undefined || args === null
        ? []
        : [args];
  return `${toolName}(${argValues.map((value) => summarizeToolArgument(value)).join(", ")})`;
}

function getAssistantToolCallDetails(message: JsonValue | undefined | null, contentIndex?: number) {
  if (!isObject(message)) {
    return null;
  }

  const content = asArray(message.content);
  const index = typeof contentIndex === "number" ? contentIndex : -1;
  const candidate = index >= 0 && index < content.length ? content[index] : null;
  const toolBlock = [candidate, ...content].find((block) => {
    if (!isObject(block)) {
      return false;
    }
    const type = asString(block.type).replace(/[_-]/g, "").toLowerCase();
    return type === "toolcall" || type === "tooluse";
  });

  if (!isObject(toolBlock)) {
    return null;
  }

  const toolName = asString(toolBlock.toolName) || asString(toolBlock.name) || "tool";
  const toolCallId = asString(toolBlock.toolCallId) || asString(toolBlock.id) || `tool-call-${toolName}`;
  const args = toolBlock.input ?? toolBlock.args ?? toolBlock.arguments ?? toolBlock.parameters ?? null;
  return {
    toolName,
    toolCallId,
    args,
    label: formatToolCallLabel(toolName, args),
  };
}

function buildToolEventMessage(args: JsonValue | undefined | null, result?: JsonValue | undefined | null, durationMs?: number | null) {
  const sections: string[] = [];
  const formattedArgs = buildCodeFence(args);
  const formattedResult = buildCodeFence(result);

  if (formattedArgs) {
    sections.push(["#### Input", formattedArgs].join("\n\n"));
  }

  if (formattedResult) {
    sections.push(["#### Output", formattedResult].join("\n\n"));
  }

  if (durationMs && Number.isFinite(durationMs)) {
    sections.push(["#### Duration", `\`\`\`text\n${durationMs}ms\n\`\`\``].join("\n\n"));
  }

  return sections.join("\n\n");
}

function deriveSessionActivityState(session: SessionRecord): SessionActivityState {
  const latestEvent = session.events[session.events.length - 1];
  if (session.status === "failed") {
    return "error";
  }
  if (latestEvent?.pending && latestEvent?.message.includes("Running tools")) {
    return "tool_running";
  }
  if (latestEvent?.thinking) {
    return "thinking";
  }
  if (session.status === "streaming") {
    return "streaming";
  }
  return "idle";
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    terminalAttached: session.terminalAttached ?? false,
    activityState: session.activityState ?? deriveSessionActivityState(session),
    lastActivityAt: session.lastActivityAt ?? session.updatedAt,
    taskId: session.taskId ?? null,
    taskProjectId: session.taskProjectId ?? null,
    taskNumber: session.taskNumber ?? null,
    taskTitle: session.taskTitle ?? null,
    activeTaskId: session.activeTaskId ?? null,
    activeTaskProjectId: session.activeTaskProjectId ?? null,
    activeTaskNumber: session.activeTaskNumber ?? null,
    activeTaskTitle: session.activeTaskTitle ?? null,
    workerType: session.workerType ?? null,
    workerName: session.workerName ?? null,
  };
}

function patchSessionRecord(session: SessionRecord, patch: (session: SessionRecord) => SessionRecord) {
  return normalizeSessionRecord(patch(session));
}

function patchStreamingAssistantEvent(
  session: SessionRecord,
  runId: string,
  timestamp: string,
  patch: (event: SessionEvent) => SessionEvent,
) {
  return patchSessionRecord(session, (current) => {
    const existingIndex = current.events.findIndex((event) => event.runId === runId && event.kind === "assistant");
    const baseEvent = existingIndex >= 0 ? current.events[existingIndex]! : buildStreamAssistantEvent(runId, timestamp);
    const nextEvent = patch(baseEvent);
    const nextEvents = existingIndex >= 0
      ? current.events.map((event, index) => (index === existingIndex ? nextEvent : event))
      : [...current.events, nextEvent];
    return {
      ...current,
      status: "streaming",
      updatedAt: timestamp,
      events: nextEvents,
    };
  });
}

function upsertSystemEvent(
  session: SessionRecord,
  eventId: string,
  runId: string,
  timestamp: string,
  message: string,
  pending = false,
  options?: Pick<SessionEvent, "label" | "presentation">,
) {
  return patchSessionRecord(session, (current) => {
    const existingIndex = current.events.findIndex((event) => event.id === eventId);
    const nextEvent: SessionEvent = {
      id: eventId,
      kind: "system",
      message,
      timestamp,
      pending,
      runId,
      label: options?.label,
      presentation: options?.presentation,
    };
    const nextEvents = existingIndex >= 0
      ? current.events.map((event, index) => (index === existingIndex ? nextEvent : event))
      : [...current.events, nextEvent];
    return {
      ...current,
      status: "streaming",
      updatedAt: timestamp,
      events: nextEvents,
    };
  });
}

function updatePendingRun(session: SessionRecord, pendingRun: PendingSessionRun) {
  return patchSessionRecord(session, (current) => {
    const persistedEvents = current.events.filter((event) => event.runId !== pendingRun.runId);
    return {
      ...current,
      status: "streaming",
      updatedAt: pendingRun.userEvent.timestamp,
      events: [
        ...persistedEvents,
        pendingRun.userEvent,
        ...(pendingRun.assistantEvent ? [pendingRun.assistantEvent] : []),
      ],
    };
  });
}

export function createPendingUserRun(runId: string, message: string, timestamp: string): PendingSessionRun {
  return {
    runId,
    userEvent: {
      id: `pending-user-${runId}`,
      kind: "user",
      message,
      timestamp,
      pending: true,
      runId,
    },
  };
}

export function applyPendingRunToSession(session: SessionRecord, pendingRun: PendingSessionRun) {
  return updatePendingRun(session, pendingRun);
}

export function removePendingRunFromSession(session: SessionRecord, runId: string) {
  return patchSessionRecord(session, (current) => ({
    ...current,
    events: current.events.filter((event) => event.runId !== runId),
  }));
}

export function reduceSessionTranscriptEvent(
  session: SessionRecord,
  pendingRun: PendingSessionRun | undefined,
  payload: SessionStreamEnvelope,
): SessionTranscriptReduction | null {
  const eventType = getRpcEventType(payload);
  const eventTimestamp = payload.receivedAt;
  const runId = payload.runId ?? createClientId("run");

  if (eventType === "agent_start") {
    return {
      session: patchSessionRecord(session, (current) => ({
        ...current,
        status: "streaming",
        updatedAt: eventTimestamp,
      })),
      pendingRun,
    };
  }

  if (eventType === "message_start") {
    const rpcEvent = isObject(payload.event) ? payload.event : null;
    const message = rpcEvent?.message;
    const role = isObject(message) ? asString(message.role) : "";

    if (role === "user") {
      if (!pendingRun) {
        return null;
      }
      const nextPendingRun: PendingSessionRun = {
        ...pendingRun,
        userEvent: {
          ...pendingRun.userEvent,
          pending: false,
          timestamp: eventTimestamp,
        },
      };
      return {
        session: updatePendingRun(session, nextPendingRun),
        pendingRun: nextPendingRun,
      };
    }

    if (role === "assistant") {
      const messageText = extractRpcMessageText(message);
      const thinkingText = extractRpcThinkingText(message);
      if (pendingRun) {
        const nextPendingRun: PendingSessionRun = {
          ...pendingRun,
          userEvent: {
            ...pendingRun.userEvent,
            pending: false,
          },
          assistantEvent: pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp, {
            message: messageText,
            thinkingText,
            thinking: Boolean(thinkingText.trim()),
          }),
        };
        return {
          session: updatePendingRun(session, nextPendingRun),
          pendingRun: nextPendingRun,
        };
      }
      return {
        session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
          ...event,
          pending: true,
          thinking: Boolean(thinkingText.trim()),
          thinkingText: thinkingText || event.thinkingText,
          message: messageText || event.message,
          timestamp: eventTimestamp,
        })),
      };
    }
    return null;
  }

  if (eventType === "message_update") {
    const deltaType = getRpcAssistantDeltaType(payload);
    const rpcEvent = isObject(payload.event) ? payload.event : null;
    const message = rpcEvent?.message;
    const delta = isObject(rpcEvent?.assistantMessageEvent) ? rpcEvent?.assistantMessageEvent : null;
    const thinkingText = extractRpcThinkingText(message);

    switch (deltaType) {
      case "thinking_start": {
        if (pendingRun) {
          const nextPendingRun: PendingSessionRun = {
            ...pendingRun,
            userEvent: {
              ...pendingRun.userEvent,
              pending: false,
            },
            assistantEvent: pendingRun.assistantEvent
              ? {
                  ...pendingRun.assistantEvent,
                  pending: true,
                  thinking: true,
                  thinkingText: pendingRun.assistantEvent.thinkingText || thinkingText,
                  timestamp: eventTimestamp,
                }
              : buildPendingAssistantEvent(runId, eventTimestamp, {
                  thinking: true,
                  thinkingText,
                }),
          };
          return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
        }
        return {
          session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
            ...event,
            pending: true,
            thinking: true,
            thinkingText: event.thinkingText || thinkingText,
            timestamp: eventTimestamp,
          })),
        };
      }
      case "thinking_delta": {
        const chunk = delta ? asString(delta.delta) : "";
        if (pendingRun) {
          const base = pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp, { thinking: true });
          const nextPendingRun: PendingSessionRun = {
            ...pendingRun,
            userEvent: {
              ...pendingRun.userEvent,
              pending: false,
            },
            assistantEvent: {
              ...base,
              thinking: true,
              pending: true,
              thinkingText: `${base.thinkingText ?? ""}${chunk}`,
              timestamp: eventTimestamp,
            },
          };
          return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
        }
        return {
          session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
            ...event,
            thinking: true,
            pending: true,
            thinkingText: `${event.thinkingText ?? ""}${chunk}`,
            timestamp: eventTimestamp,
          })),
        };
      }
      case "thinking_end": {
        if (pendingRun) {
          const nextPendingRun: PendingSessionRun = {
            ...pendingRun,
            assistantEvent: pendingRun.assistantEvent
              ? {
                  ...pendingRun.assistantEvent,
                  thinking: false,
                  pending: true,
                  thinkingText: thinkingText || pendingRun.assistantEvent.thinkingText,
                }
              : buildPendingAssistantEvent(runId, eventTimestamp, {
                  thinking: false,
                  thinkingText,
                }),
          };
          return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
        }
        return {
          session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
            ...event,
            thinking: false,
            pending: true,
            thinkingText: thinkingText || event.thinkingText,
          })),
        };
      }
      case "text_start": {
        if (pendingRun) {
          const nextPendingRun: PendingSessionRun = {
            ...pendingRun,
            userEvent: {
              ...pendingRun.userEvent,
              pending: false,
            },
            assistantEvent: pendingRun.assistantEvent
              ? {
                  ...pendingRun.assistantEvent,
                  pending: true,
                  thinking: false,
                  message: hasVisibleAssistantText(pendingRun.assistantEvent) ? pendingRun.assistantEvent.message : "",
                }
              : buildPendingAssistantEvent(runId, eventTimestamp, { thinkingText }),
          };
          return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
        }
        return {
          session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
            ...event,
            pending: true,
            thinking: false,
            thinkingText: thinkingText || event.thinkingText,
            message: hasVisibleAssistantText(event) ? event.message : "",
          })),
        };
      }
      case "text_delta": {
        const chunk = delta ? asString(delta.delta) : "";
        if (pendingRun) {
          const base = pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp, { thinkingText });
          const nextPendingRun: PendingSessionRun = {
            ...pendingRun,
            userEvent: {
              ...pendingRun.userEvent,
              pending: false,
            },
            assistantEvent: {
              ...base,
              message: hasVisibleAssistantText(base) ? `${base.message}${chunk}` : chunk,
              pending: true,
              thinking: false,
              timestamp: eventTimestamp,
            },
          };
          return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
        }
        return {
          session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
            ...event,
            message: hasVisibleAssistantText(event) ? `${event.message}${chunk}` : chunk,
            pending: true,
            thinking: false,
            thinkingText: thinkingText || event.thinkingText,
            timestamp: eventTimestamp,
          })),
        };
      }
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end": {
        const toolCall = getAssistantToolCallDetails(message, asNumber(delta?.contentIndex));
        const toolCallId = toolCall?.toolCallId ?? `${runId}-toolcall`;
        const toolEventId = `tool-execution-${toolCallId}`;
        const nextSessionBase = pendingRun
          ? updatePendingRun(session, {
              ...pendingRun,
              userEvent: {
                ...pendingRun.userEvent,
                pending: false,
              },
              assistantEvent: pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp),
            })
          : patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
              ...event,
              pending: true,
              thinking: false,
              timestamp: eventTimestamp,
            }));

        return {
          session: toolCall
            ? upsertSystemEvent(
                nextSessionBase,
                toolEventId,
                runId,
                eventTimestamp,
                buildToolEventMessage(toolCall.args),
                true,
                { label: toolCall.label, presentation: "tool_call" },
              )
            : nextSessionBase,
          pendingRun: pendingRun
            ? {
                ...pendingRun,
                userEvent: {
                  ...pendingRun.userEvent,
                  pending: false,
                },
                assistantEvent: pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp),
              }
            : undefined,
        };
      }
      case "error":
        return {
          session: patchSessionRecord(session, (current) => ({
            ...current,
            status: "failed",
            updatedAt: eventTimestamp,
            events: current.events.filter((event) => event.runId !== runId),
          })),
          sessionActionError: asString(delta?.message) || extractRpcMessageText(message) || "Session action failed.",
        };
      default:
        return null;
    }
  }

  if (eventType === "tool_execution_start" || eventType === "tool_execution_update" || eventType === "tool_execution_end") {
    const rpcEvent = isObject(payload.event) ? payload.event : null;
    const toolName = asString(rpcEvent?.toolName) || "tool";
    const toolCallId = asString(rpcEvent?.toolCallId) || `${runId}-${toolName}`;
    const args = rpcEvent?.args;
    const toolEventId = `tool-execution-${toolCallId}`;

    const nextPendingRun = pendingRun
      ? {
          ...pendingRun,
          userEvent: {
            ...pendingRun.userEvent,
            pending: false,
          },
          assistantEvent: pendingRun.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp),
        }
      : undefined;
    const nextSessionBase = nextPendingRun
      ? updatePendingRun(session, nextPendingRun)
      : patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
          ...event,
          message: event.message || "Running tools…",
          pending: true,
          thinking: false,
        }));

    const toolCallLabel = formatToolCallLabel(toolName, args);

    if (eventType === "tool_execution_start") {
      return {
        session: upsertSystemEvent(
          patchSessionRecord(nextSessionBase, (current) => ({
            ...current,
            activityState: "tool_running",
            activeToolName: toolName,
            lastActivityAt: eventTimestamp,
          })),
          toolEventId,
          runId,
          eventTimestamp,
          buildToolEventMessage(args),
          true,
          { label: toolCallLabel, presentation: "tool_call" },
        ),
        pendingRun: nextPendingRun,
      };
    }

    if (eventType === "tool_execution_update") {
      const partialResult = isObject(rpcEvent?.partialResult) ? rpcEvent?.partialResult : null;
      const partialContent = partialResult?.content;
      return {
        session: upsertSystemEvent(
          patchSessionRecord(nextSessionBase, (current) => ({
            ...current,
            activityState: "tool_running",
            activeToolName: toolName,
            lastActivityAt: eventTimestamp,
          })),
          toolEventId,
          runId,
          eventTimestamp,
          buildToolEventMessage(args, partialContent ?? partialResult),
          true,
          { label: toolCallLabel, presentation: "tool_call" },
        ),
        pendingRun: nextPendingRun,
      };
    }

    const result = rpcEvent?.result;
    const isError = rpcEvent?.isError === true;
    const durationMs = Number(rpcEvent?.durationMs ?? 0) || undefined;
    return {
      session: upsertSystemEvent(
        patchSessionRecord(nextSessionBase, (current) => ({
          ...current,
          activityState: isError ? "error" : "idle",
          activeToolName: null,
          lastActivityAt: eventTimestamp,
        })),
        toolEventId,
        runId,
        eventTimestamp,
        buildToolEventMessage(args, result, durationMs),
        false,
        { label: toolCallLabel, presentation: "tool_call" },
      ),
      pendingRun: nextPendingRun,
    };
  }

  if (eventType === "turn_end") {
    const rpcEvent = isObject(payload.event) ? payload.event : null;
    const finalMessage = extractRpcMessageText(rpcEvent?.message);
    const finalThinkingText = extractRpcThinkingText(rpcEvent?.message);
    if (!finalMessage.trim() && !finalThinkingText.trim()) {
      return null;
    }

    if (pendingRun) {
      const nextPendingRun: PendingSessionRun = {
        ...pendingRun,
        userEvent: {
          ...pendingRun.userEvent,
          pending: false,
        },
        assistantEvent: pendingRun.assistantEvent
          ? {
              ...pendingRun.assistantEvent,
              message: finalMessage,
              thinkingText: finalThinkingText || pendingRun.assistantEvent.thinkingText,
              pending: false,
              thinking: false,
              timestamp: eventTimestamp,
            }
          : buildPendingAssistantEvent(runId, eventTimestamp, {
              message: finalMessage,
              thinkingText: finalThinkingText,
              pending: false,
              thinking: false,
            }),
      };
      return { session: updatePendingRun(session, nextPendingRun), pendingRun: nextPendingRun };
    }

    return {
      session: patchStreamingAssistantEvent(session, runId, eventTimestamp, (event) => ({
        ...event,
        message: finalMessage,
        thinkingText: finalThinkingText || event.thinkingText,
        pending: false,
        thinking: false,
        timestamp: eventTimestamp,
      })),
    };
  }

  if (eventType === "agent_end") {
    return {
      session,
      refreshFromBackend: true,
    };
  }

  if (eventType === "error") {
    const rpcEvent = isObject(payload.event) ? payload.event : null;
    return {
      session: patchSessionRecord(session, (current) => ({
        ...current,
        status: "failed",
        activityState: "error",
        activeToolName: null,
        lastActivityAt: eventTimestamp,
        updatedAt: eventTimestamp,
        events: current.events.filter((event) => event.runId !== runId),
      })),
      sessionActionError: asString(rpcEvent?.message) || "Session action failed.",
    };
  }

  return null;
}
