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
}) {
  return input.activePage === "chat"
    && input.visibleChatSessionId === input.erroredSessionId
    && !input.liveSessionIds.includes(input.erroredSessionId);
}
