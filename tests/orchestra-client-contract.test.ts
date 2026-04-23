import { describe, expect, test } from "vitest";

import {
  mapHttpStatusToOrchestraClientErrorCode,
  normalizeOrchestraClientError,
} from "../src/lib/orchestraClient/errors";
import {
  toOrchestraInboxChangeDelivery,
  toOrchestraSessionChangeDelivery,
  toOrchestraSessionStreamDelivery,
  toOrchestraTaskChangeDelivery,
} from "../src/lib/orchestraClient/events";
import type {
  InboxChangeEvent,
  SessionChangeEvent,
  SessionStreamEnvelope,
  TaskChangeEvent,
} from "../src/types";

describe("orchestra client contract helpers", () => {
  test("maps HTTP status codes into the shared frontend error taxonomy", () => {
    expect(mapHttpStatusToOrchestraClientErrorCode(400)).toBe("validation");
    expect(mapHttpStatusToOrchestraClientErrorCode(401)).toBe("unauthorized");
    expect(mapHttpStatusToOrchestraClientErrorCode(403)).toBe("forbidden");
    expect(mapHttpStatusToOrchestraClientErrorCode(404)).toBe("not_found");
    expect(mapHttpStatusToOrchestraClientErrorCode(409)).toBe("conflict");
    expect(mapHttpStatusToOrchestraClientErrorCode(429)).toBe("rate_limited");
    expect(mapHttpStatusToOrchestraClientErrorCode(408)).toBe("timeout");
    expect(mapHttpStatusToOrchestraClientErrorCode(501)).toBe("unsupported");
    expect(mapHttpStatusToOrchestraClientErrorCode(503)).toBe("unavailable");
    expect(mapHttpStatusToOrchestraClientErrorCode(999)).toBe("unknown");
    expect(mapHttpStatusToOrchestraClientErrorCode()).toBe("unknown");
  });

  test("normalizes retryable transport failures consistently", () => {
    const timeoutError = normalizeOrchestraClientError(new Error("request timed out"), {
      operation: "sessions.subscribe",
      source: "remote_api",
      fallbackMessage: "Unable to subscribe.",
      status: 408,
    });

    expect(timeoutError).toMatchObject({
      name: "OrchestraClientError",
      code: "timeout",
      message: "request timed out",
      retryable: true,
      status: 408,
      source: "remote_api",
      operation: "sessions.subscribe",
    });

    const explicitNonRetryable = normalizeOrchestraClientError("forbidden", {
      operation: "tasks.update",
      source: "adapter",
      fallbackMessage: "Unable to update task.",
      code: "forbidden",
      retryable: false,
    });

    expect(explicitNonRetryable.retryable).toBe(false);
    expect(explicitNonRetryable.code).toBe("forbidden");
    expect(explicitNonRetryable.message).toBe("forbidden");
  });

  test("wraps shared event payloads with stable discriminants", () => {
    const sessionChange: SessionChangeEvent = {
      sessionIds: ["session-1"],
      reason: "session.updated",
    };
    const sessionStream: SessionStreamEnvelope = {
      sessionId: "session-1",
      runId: "run-1",
      event: { type: "assistant.delta", text: "hello" },
      receivedAt: "2026-04-22T00:00:00.000Z",
    };
    const taskChange: TaskChangeEvent = {
      taskIds: ["task-1"],
      reason: "task.updated",
    };
    const inboxChange: InboxChangeEvent = {
      deliveryIds: ["delivery-1"],
      reason: "mail.read",
    };

    expect(toOrchestraSessionChangeDelivery(sessionChange)).toEqual({
      kind: "session.change",
      ...sessionChange,
    });
    expect(toOrchestraSessionStreamDelivery(sessionStream)).toEqual({
      kind: "session.stream",
      ...sessionStream,
    });
    expect(toOrchestraTaskChangeDelivery(taskChange)).toEqual({
      kind: "task.change",
      ...taskChange,
    });
    expect(toOrchestraInboxChangeDelivery(inboxChange)).toEqual({
      kind: "inbox.change",
      ...inboxChange,
    });
  });
});
