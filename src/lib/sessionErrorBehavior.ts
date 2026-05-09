export function isFallbackChatSessionView(input: {
  activePage: string;
  chatSessionId: string | null;
  hasLiveChatSession: boolean;
}) {
  return input.activePage === "chat"
    && Boolean(input.chatSessionId)
    && !input.hasLiveChatSession;
}

export function shouldSuppressPassiveChatSessionLoadError(input: {
  activePage: string;
  visibleChatSessionId: string | null;
  erroredSessionId: string;
  liveSessionIds: string[];
  errorCode?: string | null;
}) {
  return input.activePage === "chat"
    && input.visibleChatSessionId === input.erroredSessionId
    && (
      input.errorCode === "not_found"
      || !input.liveSessionIds.includes(input.erroredSessionId)
    );
}

export function shouldSuppressChatSessionRecoveryError(input: {
  activePage: string;
  selectedAgentId: string | null;
  fallbackAgentId: string | null;
  fallbackSessionId: string | null;
  errorCode?: string | null;
}) {
  return input.activePage === "chat"
    && Boolean(input.fallbackSessionId)
    && Boolean(input.selectedAgentId)
    && input.selectedAgentId === input.fallbackAgentId
    && input.errorCode === "not_found";
}
