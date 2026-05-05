import { describe, expect, it } from "vitest";

import { toOrchestraClientError } from "../src/lib/orchestraClient/errors";

describe("orchestra client session error normalization", () => {
  it("downgrades canonical session drift diagnostics to a user-safe not-found session message", () => {
    const error = toOrchestraClientError(
      "Session 123e4567-e89b-12d3-a456-426614174000 was not found in canonical session rows for project orchestra; run explicit session reconciliation to inspect legacy drift",
      {
        operation: "sessions.get",
        source: "tauri",
        fallbackMessage: "sessions.get failed.",
      },
    );

    expect(error.code).toBe("not_found");
    expect(error.userMessage).toBe(
      "This session is no longer available. Refresh the session list or reopen the latest chat to continue.",
    );
    expect(error.message).toContain("explicit session reconciliation");
  });

  it("leaves unrelated session transport errors unchanged", () => {
    const error = toOrchestraClientError(
      "Session websocket transport disconnected unexpectedly",
      {
        operation: "sessions.get",
        source: "tauri",
        fallbackMessage: "sessions.get failed.",
      },
    );

    expect(error.code).toBe("transport");
    expect(error.userMessage).toBeNull();
  });
});
