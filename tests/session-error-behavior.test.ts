import { describe, expect, it } from "vitest";

import {
  isFallbackChatSessionView,
  shouldSuppressPassiveChatSessionLoadError,
} from "../src/lib/sessionErrorBehavior";

describe("session error behavior helpers", () => {
  it("treats remembered chat sessions without a live row as fallback chat state", () => {
    expect(
      isFallbackChatSessionView({
        activePage: "chat",
        chatSessionId: "session-1",
        hasLiveChatSession: false,
      }),
    ).toBe(true);

    expect(
      isFallbackChatSessionView({
        activePage: "sessions",
        chatSessionId: "session-1",
        hasLiveChatSession: false,
      }),
    ).toBe(false);
  });

  it("suppresses passive chat session load errors only for stale visible chat sessions", () => {
    expect(
      shouldSuppressPassiveChatSessionLoadError({
        activePage: "chat",
        visibleChatSessionId: "session-1",
        erroredSessionId: "session-1",
        liveSessionIds: [],
      }),
    ).toBe(true);

    expect(
      shouldSuppressPassiveChatSessionLoadError({
        activePage: "chat",
        visibleChatSessionId: "session-1",
        erroredSessionId: "session-1",
        liveSessionIds: ["session-1"],
      }),
    ).toBe(false);

    expect(
      shouldSuppressPassiveChatSessionLoadError({
        activePage: "sessions",
        visibleChatSessionId: "session-1",
        erroredSessionId: "session-1",
        liveSessionIds: [],
      }),
    ).toBe(false);
  });
});
