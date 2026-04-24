import { describe, expect, it, vi } from "vitest";

import {
  dispatchAgentCatalogChanged,
  listenToAgentCatalogChanges,
  ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT,
} from "../src/lib/agentCatalogEvents";

describe("agent catalog change events", () => {
  it("dispatches structured change details to listeners", () => {
    const target = new EventTarget();
    const received: Array<{ agentId: string; projectId: string | null; reason: string }> = [];

    const stopListening = listenToAgentCatalogChanges((detail) => {
      received.push(detail);
    }, target);

    dispatchAgentCatalogChanged({ agentId: "agent-1", projectId: "project-1", reason: "updated" }, target);
    stopListening();

    expect(received).toEqual([{ agentId: "agent-1", projectId: "project-1", reason: "updated" }]);
  });

  it("removes listeners cleanly", () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const stopListening = listenToAgentCatalogChanges(handler, target);

    stopListening();
    target.dispatchEvent(new CustomEvent(ORCHESTRA_AGENT_CATALOG_CHANGED_EVENT, {
      detail: { agentId: "agent-2", projectId: null, reason: "archived" },
    }));

    expect(handler).not.toHaveBeenCalled();
  });
});
