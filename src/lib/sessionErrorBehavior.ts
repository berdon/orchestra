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
  errorCode?: string | null;
}) {
  return input.activePage === "chat"
    && Boolean(input.selectedAgentId)
    && input.errorCode === "not_found"
    && (!input.fallbackAgentId || input.selectedAgentId === input.fallbackAgentId);
}
