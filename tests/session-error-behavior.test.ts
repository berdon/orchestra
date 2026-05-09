import { describe, expect, it } from "vitest";

import {
  isFallbackChatSessionView,
  shouldSuppressChatSessionRecoveryError,
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

  it("suppresses passive chat session load errors for stale visible chat sessions and not-found replacements", () => {
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
        errorCode: "not_found",
      }),
    ).toBe(true);

    expect(
      shouldSuppressPassiveChatSessionLoadError({
        activePage: "chat",
        visibleChatSessionId: "session-1",
        erroredSessionId: "session-1",
        liveSessionIds: ["session-1"],
        errorCode: "transport",
      }),
    ).toBe(false);

    expect(
      shouldSuppressPassiveChatSessionLoadError({
        activePage: "sessions",
        visibleChatSessionId: "session-1",
        erroredSessionId: "session-1",
        liveSessionIds: [],
        errorCode: "not_found",
      }),
    ).toBe(false);
  });

  it("suppresses chat recovery not-found errors while the same agent fallback session is still visible", () => {
    expect(
      shouldSuppressChatSessionRecoveryError({
        activePage: "chat",
        selectedAgentId: "agent-1",
        fallbackAgentId: "agent-1",
        fallbackSessionId: "session-1",
        errorCode: "not_found",
      }),
    ).toBe(true);

    expect(
      shouldSuppressChatSessionRecoveryError({
        activePage: "chat",
        selectedAgentId: "agent-1",
        fallbackAgentId: "agent-2",
        fallbackSessionId: "session-1",
        errorCode: "not_found",
      }),
    ).toBe(false);

    expect(
      shouldSuppressChatSessionRecoveryError({
        activePage: "chat",
        selectedAgentId: "agent-1",
        fallbackAgentId: "agent-1",
        fallbackSessionId: null,
        errorCode: "not_found",
      }),
    ).toBe(false);
  });
});
