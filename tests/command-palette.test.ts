import { describe, expect, it } from "vitest";

import { buildCommandPaletteItems } from "../src/lib/commandPalette";
import { fuzzySearch } from "../src/lib/fuzzy";

describe("command palette items", () => {
  it("builds navigation, entity, and action commands", () => {
    const items = buildCommandPaletteItems({
      sessions: [
        {
          id: "session-1",
          title: "Supervisor session",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          subscribed: true,
          events: [],
        },
      ],
      tasks: [
        {
          id: "task-1",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Ship command palette",
          status: "in_progress",
          priority: "P1",
          type: "feature",
          assigneeType: "agent",
          assigneeId: "agent-1",
          dependencyBlocked: false,
          readyForDispatch: true,
          archived: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          parentTaskId: null,
          workflowId: null,
          currentLaneId: null,
          commentCount: 0,
          laneRunCount: 0,
          childCount: 0,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 0,
          blockingCount: 0,
          attachmentCount: 0,
        },
      ],
      agents: [
        {
          agent: {
            id: "agent-1",
            slug: "data",
            name: "Data",
            description: null,
            systemPrompt: null,
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            roleId: null,
            thinkingLevel: "medium",
            policyIds: [],
            directPermissions: [],
            system: false,
            immutable: false,
            archived: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          runtimeState: {
            projectId: "orchestra",
            agentId: "agent-1",
            status: "idle",
            mainSessionId: null,
            runtimeCwd: null,
            currentQueueEntryId: null,
            lastDispatchAt: null,
            lastError: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          queuedCount: 0,
          dispatchedCount: 0,
        },
      ],
      roles: [
        {
          role: {
            id: "role-1",
            slug: "reviewer",
            name: "Reviewer",
            thinkingLevel: "off",
            capacity: 1,
            policyIds: [],
            directPermissions: [],
            archived: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          queuedCount: 1,
          assignedCount: 0,
          activeInstanceCount: 1,
          idleInstanceCount: 0,
          latestError: null,
        },
      ],
      workflows: [
        {
          id: "workflow-1",
          slug: "development",
          name: "Development",
          description: "Default flow",
          archived: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      projects: [
        {
          id: "orchestra",
          slug: "orchestra",
          name: "Orchestra",
          description: "Default project",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      activeProjectId: "orchestra",
    });

    expect(items.some((item) => item.action.type === "create-task")).toBe(true);
    expect(items.some((item) => item.action.type === "launch-agent-session" && item.action.agentId === "agent-1")).toBe(true);
    expect(items.some((item) => item.action.type === "launch-agent-session-terminal" && item.action.agentId === "agent-1")).toBe(true);
    expect(items.some((item) => item.action.type === "open-role" && item.action.roleId === "role-1")).toBe(true);
    expect(items.some((item) => item.action.type === "open-workflow" && item.action.workflowId === "workflow-1")).toBe(true);
    expect(items.some((item) => item.action.type === "open-session" && item.action.sessionId === "session-1")).toBe(true);
  });

  it("adds fuzzy project-switch commands for non-active projects", () => {
    const items = buildCommandPaletteItems({
      sessions: [],
      tasks: [],
      agents: [],
      roles: [],
      workflows: [],
      projects: [
        {
          id: "orchestra",
          slug: "orchestra",
          name: "Orchestra",
          description: "Default project",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "project-2",
          slug: "second-project",
          name: "Second Project",
          description: "Customer delivery work",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      activeProjectId: "orchestra",
    });

    expect(items.some((item) => item.action.type === "switch-project" && item.action.projectId === "orchestra")).toBe(false);

    const rankedMatches = fuzzySearch("snd prj", items, 5);
    expect(rankedMatches[0]?.item.title).toBe("Switch to project Second Project");
    expect(rankedMatches[0]?.item.action).toEqual({ type: "switch-project", projectId: "project-2" });
  });
});
