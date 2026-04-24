import { describe, expect, it } from "vitest";

import { shouldApplyChatAgentLoad } from "../src/pages/chat/chatAgentLoadGuards";

describe("chat agent load guards", () => {
  it("accepts only the latest chat-agent load for the active chat project", () => {
    expect(shouldApplyChatAgentLoad("chat", "project-b", "project-b", 4, 4)).toBe(true);
    expect(shouldApplyChatAgentLoad("chat", "project-a", "project-b", 4, 4)).toBe(false);
    expect(shouldApplyChatAgentLoad("chat", "project-b", "project-b", 3, 4)).toBe(false);
    expect(shouldApplyChatAgentLoad("sessions", "project-b", "project-b", 4, 4)).toBe(false);
  });

  it("treats null project ids consistently for the global chat catalog", () => {
    expect(shouldApplyChatAgentLoad("chat", null, null, 2, 2)).toBe(true);
    expect(shouldApplyChatAgentLoad("chat", null, "project-a", 2, 2)).toBe(false);
  });
});
