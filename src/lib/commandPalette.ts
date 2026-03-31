import type {
  AgentOperationsSnapshot,
  PrimaryPage,
  RoleOperationsSnapshot,
  SessionRecord,
  SettingsTab,
  TaskSummary,
  WorkflowSummary,
} from "../types";
import type { FuzzySearchCandidate } from "./fuzzy";

export type CommandPaletteAction =
  | { type: "navigate-page"; page: PrimaryPage }
  | { type: "navigate-settings"; tab: SettingsTab }
  | { type: "open-task"; taskId: string }
  | { type: "open-session"; sessionId: string }
  | { type: "open-agent"; agentId: string }
  | { type: "open-role"; roleId: string }
  | { type: "open-workflow"; workflowId: string }
  | { type: "create-task" }
  | { type: "create-session" }
  | { type: "open-logs" }
  | { type: "open-supervisor-chat" }
  | { type: "launch-agent-session"; agentId: string }
  | { type: "launch-agent-session-terminal"; agentId: string };

export interface CommandPaletteItem extends FuzzySearchCandidate {
  title: string;
  subtitle?: string;
  group: string;
  action: CommandPaletteAction;
}

interface BuildCommandPaletteItemsOptions {
  sessions: SessionRecord[];
  tasks: TaskSummary[];
  agents: AgentOperationsSnapshot[];
  roles: RoleOperationsSnapshot[];
  workflows: WorkflowSummary[];
}

function commandItem(input: Omit<CommandPaletteItem, "label">): CommandPaletteItem {
  return {
    ...input,
    label: input.title,
  };
}

export function buildCommandPaletteItems({ sessions, tasks, agents, roles, workflows }: BuildCommandPaletteItemsOptions): CommandPaletteItem[] {
  const pageItems: CommandPaletteItem[] = [
    commandItem({
      id: "page-tasks",
      title: "Go to Tasks",
      subtitle: "Workflow command center",
      group: "Pages",
      keywords: ["tasks", "board", "workflow", "tickets"],
      action: { type: "navigate-page", page: "tasks" },
    }),
    commandItem({
      id: "page-agents",
      title: "Go to Agents",
      subtitle: "Workforce operations",
      group: "Pages",
      keywords: ["agents", "workers", "roles", "runtime"],
      action: { type: "navigate-page", page: "agents" },
    }),
    commandItem({
      id: "page-sessions",
      title: "Go to Sessions",
      subtitle: "Live execution transcripts",
      group: "Pages",
      keywords: ["sessions", "chat", "transcript"],
      action: { type: "navigate-page", page: "sessions" },
    }),
    commandItem({
      id: "settings-projects",
      title: "Open Settings → Projects",
      subtitle: "Project and repository management",
      group: "Pages",
      keywords: ["settings", "projects", "repositories"],
      action: { type: "navigate-settings", tab: "projects" },
    }),
    commandItem({
      id: "settings-agents",
      title: "Open Settings → Agents",
      subtitle: "Persistent agent definitions",
      group: "Pages",
      keywords: ["settings", "agents", "definitions"],
      action: { type: "navigate-settings", tab: "agents" },
    }),
    commandItem({
      id: "settings-roles",
      title: "Open Settings → Roles",
      subtitle: "Role definitions",
      group: "Pages",
      keywords: ["settings", "roles"],
      action: { type: "navigate-settings", tab: "roles" },
    }),
    commandItem({
      id: "settings-workflows",
      title: "Open Settings → Workflows",
      subtitle: "Workflow definitions",
      group: "Pages",
      keywords: ["settings", "workflows", "lanes"],
      action: { type: "navigate-settings", tab: "workflows" },
    }),
    commandItem({
      id: "settings-general",
      title: "Open Settings → General",
      subtitle: "Bridge diagnostics and runtime logs",
      group: "Pages",
      keywords: ["settings", "general", "bridge", "diagnostics", "logs"],
      action: { type: "navigate-settings", tab: "general" },
    }),
  ];

  const actionItems: CommandPaletteItem[] = [
    commandItem({
      id: "action-create-task",
      title: "Create task",
      subtitle: "Open the new task flow",
      group: "Actions",
      keywords: ["new task", "create ticket", "task"],
      action: { type: "create-task" },
    }),
    commandItem({
      id: "action-create-session",
      title: "Create session",
      subtitle: "Start a new general session",
      group: "Actions",
      keywords: ["new session", "chat"],
      action: { type: "create-session" },
    }),
    commandItem({
      id: "action-open-logs",
      title: "Open logs window",
      subtitle: "Show runtime diagnostics",
      group: "Actions",
      keywords: ["logs", "diagnostics", "debug"],
      action: { type: "open-logs" },
    }),
    commandItem({
      id: "action-supervisor-chat",
      title: "Open supervisor quick chat",
      subtitle: "Persistent floating chat with the supervisor",
      group: "Actions",
      keywords: ["supervisor", "quick chat", "assistant"],
      action: { type: "open-supervisor-chat" },
    }),
  ];

  const taskItems = tasks.map((task) =>
    commandItem({
      id: `task-${task.id}`,
      title: `${task.number} · ${task.title}`,
      subtitle: `Task · ${task.status.replace(/_/g, " ")}`,
      group: "Tasks",
      keywords: [task.number, task.title, task.status, task.type, task.assigneeId ?? ""],
      action: { type: "open-task", taskId: task.id },
    }),
  );

  const sessionItems = sessions.map((session) =>
    commandItem({
      id: `session-${session.id}`,
      title: session.title,
      subtitle: `Session · ${session.status}`,
      group: "Sessions",
      keywords: [session.title, session.status, session.id],
      action: { type: "open-session", sessionId: session.id },
    }),
  );

  const agentItems = agents.flatMap((snapshot) => [
    commandItem({
      id: `agent-open-${snapshot.agent.id}`,
      title: snapshot.agent.name,
      subtitle: `Agent · ${snapshot.runtimeState.status}`,
      group: "Agents",
      keywords: [snapshot.agent.name, snapshot.agent.slug, snapshot.runtimeState.status, "agent"],
      action: { type: "open-agent", agentId: snapshot.agent.id },
    }),
    commandItem({
      id: `agent-launch-${snapshot.agent.id}`,
      title: `Launch ${snapshot.agent.name} session`,
      subtitle: snapshot.runtimeState.mainSessionId ? "Reopen the persistent agent session" : "Start the persistent agent session",
      group: "Actions",
      keywords: [snapshot.agent.name, snapshot.agent.slug, "launch", "agent", "session"],
      action: { type: "launch-agent-session", agentId: snapshot.agent.id },
    }),
    commandItem({
      id: `agent-terminal-${snapshot.agent.id}`,
      title: `Open ${snapshot.agent.name} in terminal`,
      subtitle: snapshot.runtimeState.terminalAttached
        ? "Terminal window already attached"
        : "Open the idle persistent agent session in an embedded terminal window",
      group: "Actions",
      keywords: [snapshot.agent.name, snapshot.agent.slug, "terminal", "ghostty", "embedded", "session"],
      action: { type: "launch-agent-session-terminal", agentId: snapshot.agent.id },
    }),
  ]);

  const roleItems = roles.map((snapshot) =>
    commandItem({
      id: `role-${snapshot.role.id}`,
      title: snapshot.role.name,
      subtitle: `Role · ${snapshot.queuedCount} queued · ${snapshot.activeInstanceCount} active`,
      group: "Roles",
      keywords: [snapshot.role.name, snapshot.role.slug, "role", "queue", "capacity"],
      action: { type: "open-role", roleId: snapshot.role.id },
    }),
  );

  const workflowItems = workflows.map((workflow) =>
    commandItem({
      id: `workflow-${workflow.id}`,
      title: workflow.name,
      subtitle: "Workflow",
      group: "Workflows",
      keywords: [workflow.name, workflow.slug, workflow.description ?? "", "workflow"],
      action: { type: "open-workflow", workflowId: workflow.id },
    }),
  );

  return [...actionItems, ...pageItems, ...taskItems, ...sessionItems, ...agentItems, ...roleItems, ...workflowItems];
}
