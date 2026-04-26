import type { PolicyDefinition } from "../types";

export const SUPERVISOR_POLICY_ID = "policy-supervisor";

export interface PermissionOption {
  key: string;
  group: string;
  label: string;
  description?: string;
  risk?: "standard" | "sensitive" | "full-access";
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { key: "agents.read", group: "Agents", label: "View agents", description: "Inspect agent definitions and metadata." },
  { key: "agents.create", group: "Agents", label: "Create agents", description: "Create new persistent agents." },
  { key: "agents.update", group: "Agents", label: "Edit agents", description: "Modify existing agent definitions." },
  { key: "agents.archive", group: "Agents", label: "Archive agents", description: "Archive agents so they no longer appear in normal lists.", risk: "sensitive" },
  { key: "roles.read", group: "Roles", label: "View roles", description: "Inspect role definitions, queues, and runtime state." },
  { key: "roles.create", group: "Roles", label: "Create roles", description: "Create new workforce roles." },
  { key: "roles.update", group: "Roles", label: "Edit roles", description: "Modify existing roles." },
  { key: "roles.archive", group: "Roles", label: "Archive roles", description: "Archive role definitions.", risk: "sensitive" },
  { key: "roles.enqueue", group: "Roles", label: "Queue role work", description: "Add work to role queues." },
  { key: "roles.dispatch", group: "Roles", label: "Dispatch role work", description: "Dispatch queued role work into active instances.", risk: "sensitive" },
  { key: "roles.release", group: "Roles", label: "Release role instances", description: "Release running role instances.", risk: "sensitive" },
  { key: "roles.dispose", group: "Roles", label: "Dispose role instances", description: "Dispose role instances and their worktrees.", risk: "sensitive" },
  { key: "sessions.read", group: "Sessions", label: "View sessions", description: "List and inspect Orchestra sessions." },
  { key: "sessions.create", group: "Sessions", label: "Create sessions", description: "Create new Orchestra sessions." },
  { key: "sessions.message", group: "Sessions", label: "Send session messages", description: "Send prompts and follow-ups into sessions." },
  { key: "sessions.model", group: "Sessions", label: "Change session models", description: "Change the model attached to a session." },
  { key: "sessions.stop", group: "Sessions", label: "Stop session runtimes", description: "Stop an active Orchestra session runtime without broader task control access.", risk: "sensitive" },
  { key: "sessions.delete", group: "Sessions", label: "Delete sessions", description: "Delete sessions and their associated state.", risk: "sensitive" },
  { key: "workflows.read", group: "Workflows", label: "View workflows", description: "Inspect workflow definitions." },
  { key: "workflows.create", group: "Workflows", label: "Create workflows", description: "Create workflow definitions." },
  { key: "workflows.update", group: "Workflows", label: "Edit workflows", description: "Modify workflow definitions." },
  { key: "workflows.archive", group: "Workflows", label: "Archive workflows", description: "Archive workflow definitions.", risk: "sensitive" },
  { key: "policies.read", group: "Policies", label: "View policies", description: "Inspect policies and resolved permissions." },
  { key: "skills.read", group: "Skills", label: "View skills", description: "Inspect the managed skills catalog, bindings, and diagnostics." },
  { key: "skills.create", group: "Skills", label: "Create skills", description: "Create new local managed skills." },
  { key: "skills.update", group: "Skills", label: "Edit skills", description: "Update local managed skills and refresh external discovery." },
  { key: "skills.archive", group: "Skills", label: "Archive skills", description: "Archive or unarchive managed skills.", risk: "sensitive" },
  { key: "skills.delete", group: "Skills", label: "Delete skills", description: "Permanently delete local managed skills.", risk: "sensitive" },
  { key: "skills.assign", group: "Skills", label: "Assign skills", description: "Manage managed-skill scope bindings and assignments." },
  { key: "projects.read", group: "Projects", label: "View projects", description: "Inspect project configuration and overlays." },
  { key: "projects.create", group: "Projects", label: "Create projects", description: "Create new Orchestra projects." },
  { key: "projects.update", group: "Projects", label: "Edit projects", description: "Update project configuration and worker overlays." },
  { key: "projects.delete", group: "Projects", label: "Delete projects", description: "Delete Orchestra projects and their managed state.", risk: "sensitive" },
  { key: "repositories.write", group: "Projects", label: "Manage repositories", description: "Create, update, attach remotes, and delete Orchestra repositories.", risk: "sensitive" },
  { key: "logs.read", group: "Logs", label: "View logs", description: "Read Orchestra runtime logs." },
  { key: "logs.clear", group: "Logs", label: "Clear logs", description: "Clear Orchestra runtime logs.", risk: "sensitive" },
  { key: "tasks.read", group: "Tasks", label: "View tasks", description: "List and inspect tasks." },
  { key: "tasks.create", group: "Tasks", label: "Create tasks", description: "Create tasks and subtasks." },
  { key: "tasks.update", group: "Tasks", label: "Edit tasks", description: "Update task fields and metadata." },
  { key: "tasks.delete", group: "Tasks", label: "Delete tasks", description: "Permanently delete tasks and their related records.", risk: "sensitive" },
  { key: "tasks.comment", group: "Tasks", label: "Comment on tasks", description: "Add comments to tasks." },
  { key: "tasks.comment.delete", group: "Tasks", label: "Delete task comments", description: "Permanently delete task comments and their child replies, attachments, and file references." , risk: "sensitive" },
  { key: "tasks.review", group: "Tasks", label: "Review paused task lanes", description: "Approve review-paused work or mark it as needing more work.", risk: "sensitive" },
  { key: "tasks.control", group: "Tasks", label: "Control active task work", description: "Pause, resume, or stop task activity on behalf of a user.", risk: "sensitive" },
  { key: "tasks.transition", group: "Tasks", label: "Advance task lanes", description: "Dispatch and transition workflow lanes.", risk: "sensitive" },
  { key: "tasks.dependencies.write", group: "Tasks", label: "Edit dependencies", description: "Add and remove task dependencies." },
  { key: "tasks.attachments.write", group: "Tasks", label: "Edit attachments", description: "Add and remove task attachments." },
];

export function hasSupervisorAccess(policyIds?: string[] | null) {
  return Boolean(policyIds?.includes(SUPERVISOR_POLICY_ID));
}

export function togglePolicy(policyIds: string[] | undefined, policyId: string, enabled: boolean) {
  const current = new Set(policyIds ?? []);
  if (enabled) {
    current.add(policyId);
  } else {
    current.delete(policyId);
  }
  return Array.from(current).sort();
}

export function togglePermission(permissions: string[] | undefined, permission: string, enabled: boolean) {
  const current = new Set(permissions ?? []);
  if (enabled) {
    current.add(permission);
  } else {
    current.delete(permission);
  }
  return Array.from(current).sort();
}

export function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

export function getPermissionOption(permission: string) {
  return PERMISSION_OPTIONS.find((option) => option.key === permission);
}

export function getPermissionLabel(permission: string) {
  return getPermissionOption(permission)?.label ?? permission;
}

export function getPolicyLabel(policy: Pick<PolicyDefinition, "name" | "slug">) {
  return policy.name?.trim() || policy.slug;
}

export function filterPermissionOptions(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return PERMISSION_OPTIONS;
  }

  return PERMISSION_OPTIONS.filter((option) => {
    return [option.key, option.group, option.label, option.description ?? ""].some((value) => value.toLowerCase().includes(normalized));
  });
}

export function groupPermissionOptions(query: string) {
  const grouped = new Map<string, PermissionOption[]>();
  for (const option of filterPermissionOptions(query)) {
    const existing = grouped.get(option.group) ?? [];
    existing.push(option);
    grouped.set(option.group, existing);
  }

  return Array.from(grouped.entries()).map(([group, options]) => ({ group, options }));
}

export function resolvePolicyPermissions(policies: PolicyDefinition[]) {
  return uniq(policies.flatMap((policy) => policy.permissions));
}

export function buildEffectivePermissions(input: {
  inheritedPermissions?: string[];
  attachedPolicies?: PolicyDefinition[];
  directPermissions?: string[];
}) {
  const permissions = uniq([
    ...(input.inheritedPermissions ?? []),
    ...resolvePolicyPermissions(input.attachedPolicies ?? []),
    ...(input.directPermissions ?? []),
  ]);

  return {
    permissions,
    grantsFullAccess: permissions.includes("*"),
  };
}
