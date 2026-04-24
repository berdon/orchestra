export const ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT = "orchestra:agent-catalog-changed";

export type AgentCatalogChangeReason = "created" | "updated" | "archived";

export type AgentCatalogChangeDetail = {
  agentId: string;
  projectId: string | null;
  reason: AgentCatalogChangeReason;
};

type BrowserEventTarget = EventTarget | Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">;

function resolveEventTarget(eventTarget?: BrowserEventTarget | null) {
  if (eventTarget) {
    return eventTarget;
  }

  return typeof window === "undefined" ? null : window;
}

export function dispatchAgentCatalogChanged(detail: AgentCatalogChangeDetail, eventTarget?: BrowserEventTarget | null) {
  const target = resolveEventTarget(eventTarget);
  if (!target) {
    return;
  }

  target.dispatchEvent(new CustomEvent(ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT, { detail }));
}

export function listenToAgentCatalogChanges(
  handler: (detail: AgentCatalogChangeDetail) => void,
  eventTarget?: BrowserEventTarget | null,
) {
  const target = resolveEventTarget(eventTarget);
  if (!target) {
    return () => {};
  }

  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as AgentCatalogChangeDetail);
    }
  };

  target.addEventListener(ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT, listener);
  return () => {
    target.removeEventListener(ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT, listener);
  };
}
