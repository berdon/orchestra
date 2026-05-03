import type { AgentSummary, RoleSummary, SessionRecord, TaskSummary } from "../types";

export interface TaskReferenceEntry {
  label: string;
  number?: string | null;
  title?: string | null;
  projectId?: string | null;
}

export interface SessionReferenceEntry {
  label: string;
  projectId?: string | null;
}

export interface WorkerReferenceEntry {
  label: string;
}

export interface EntityReferenceLookup {
  tasks: Map<string, TaskReferenceEntry>;
  sessions: Map<string, SessionReferenceEntry>;
  agents: Map<string, WorkerReferenceEntry>;
  roles: Map<string, WorkerReferenceEntry>;
}

export type RawIdMode = "secondary" | "tooltip" | "none";
export type EntityReferenceLayout = "inline" | "stacked";

function buildTaskLabel(number?: string | null, title?: string | null) {
  const safeNumber = number?.trim() ?? "";
  const safeTitle = title?.trim() ?? "";
  if (safeNumber && safeTitle) {
    return `${safeNumber} · ${safeTitle}`;
  }
  return safeNumber || safeTitle || null;
}

function buildWorkerLookup(items: Array<Pick<AgentSummary, "id" | "name">> | Array<Pick<RoleSummary, "id" | "name">>) {
  return new Map(items.map((item) => [item.id, { label: item.name }]));
}

export function buildEntityReferenceLookup({
  tasks = [],
  sessions = [],
  agents = [],
  roles = [],
}: {
  tasks?: Array<Pick<TaskSummary, "id" | "number" | "title" | "projectId">>;
  sessions?: Array<Pick<SessionRecord, "id" | "title" | "taskProjectId" | "activeTaskProjectId">>;
  agents?: Array<Pick<AgentSummary, "id" | "name">>;
  roles?: Array<Pick<RoleSummary, "id" | "name">>;
}): EntityReferenceLookup {
  return {
    tasks: new Map(tasks.map((task) => [task.id, {
      label: buildTaskLabel(task.number, task.title) ?? task.id,
      number: task.number,
      title: task.title,
      projectId: task.projectId,
    }])),
    sessions: new Map(sessions.map((session) => [session.id, {
      label: session.title,
      projectId: session.taskProjectId ?? session.activeTaskProjectId ?? null,
    }])),
    agents: buildWorkerLookup(agents),
    roles: buildWorkerLookup(roles),
  };
}

function joinTitles(...parts: Array<string | null | undefined>) {
  return parts.filter((value) => value && value.trim().length > 0).join(" · ");
}

function EntityReference({
  rawId,
  label,
  rawIdMode = "secondary",
  layout = "inline",
  className,
  title,
  onOpen,
  dataRole,
}: {
  rawId?: string | null;
  label?: string | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
  title?: string;
  onOpen?: (() => void) | null;
  dataRole?: string;
}) {
  const resolvedLabel = label?.trim() || rawId || "—";
  const showSecondaryRawId = rawIdMode === "secondary" && rawId && rawId !== resolvedLabel;
  const resolvedTitle = title ?? (rawIdMode === "tooltip" && rawId && rawId !== resolvedLabel ? rawId : undefined);
  const classes = [
    "entity-reference",
    layout === "stacked" ? "entity-reference--stacked" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <span className={classes}>
      {onOpen && rawId ? (
        <button
          className="entity-reference__link"
          data-role={dataRole}
          title={resolvedTitle}
          type="button"
          onClick={onOpen}
        >
          {resolvedLabel}
        </button>
      ) : (
        <span className="entity-reference__label" data-role={dataRole} title={resolvedTitle}>{resolvedLabel}</span>
      )}
      {showSecondaryRawId ? <code className="entity-reference__raw-id">{rawId}</code> : null}
    </span>
  );
}

export function TaskReferenceLink({
  taskId,
  taskNumber,
  taskTitle,
  projectId = null,
  lookup,
  onOpenTask,
  rawIdMode = "secondary",
  layout = "inline",
  className,
  dataRole,
}: {
  taskId?: string | null;
  taskNumber?: string | null;
  taskTitle?: string | null;
  projectId?: string | null;
  lookup?: Map<string, TaskReferenceEntry>;
  onOpenTask?: ((taskId: string, projectId?: string | null) => void) | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
  dataRole?: string;
}) {
  const taskEntry = taskId ? lookup?.get(taskId) : undefined;
  const label = buildTaskLabel(taskNumber ?? taskEntry?.number, taskTitle ?? taskEntry?.title) ?? taskEntry?.label ?? taskId ?? null;
  const targetProjectId = projectId ?? taskEntry?.projectId ?? null;
  return (
    <EntityReference
      className={className}
      dataRole={dataRole}
      label={label}
      layout={layout}
      onOpen={taskId && onOpenTask ? () => onOpenTask(taskId, targetProjectId) : null}
      rawId={taskId}
      rawIdMode={rawIdMode}
    />
  );
}

export function SessionReferenceLink({
  sessionId,
  sessionTitle,
  projectId = null,
  lookup,
  onOpenSession,
  rawIdMode = "secondary",
  layout = "inline",
  className,
  dataRole,
}: {
  sessionId?: string | null;
  sessionTitle?: string | null;
  projectId?: string | null;
  lookup?: Map<string, SessionReferenceEntry>;
  onOpenSession?: ((sessionId: string, projectId?: string | null) => void) | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
  dataRole?: string;
}) {
  const sessionEntry = sessionId ? lookup?.get(sessionId) : undefined;
  return (
    <EntityReference
      className={className}
      dataRole={dataRole}
      label={sessionTitle ?? sessionEntry?.label ?? sessionId ?? null}
      layout={layout}
      onOpen={sessionId && onOpenSession ? () => onOpenSession(sessionId, projectId ?? sessionEntry?.projectId ?? null) : null}
      rawId={sessionId}
      rawIdMode={rawIdMode}
    />
  );
}

export function AgentReferenceLink({
  agentId,
  agentName,
  lookup,
  onOpenAgent,
  rawIdMode = "secondary",
  layout = "inline",
  className,
  dataRole,
}: {
  agentId?: string | null;
  agentName?: string | null;
  lookup?: Map<string, WorkerReferenceEntry>;
  onOpenAgent?: ((agentId: string) => void) | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
  dataRole?: string;
}) {
  return (
    <EntityReference
      className={className}
      dataRole={dataRole}
      label={agentName ?? (agentId ? lookup?.get(agentId)?.label : null) ?? agentId ?? null}
      layout={layout}
      onOpen={agentId && onOpenAgent ? () => onOpenAgent(agentId) : null}
      rawId={agentId}
      rawIdMode={rawIdMode}
    />
  );
}

export function RoleReferenceLink({
  roleId,
  roleName,
  lookup,
  onOpenRole,
  rawIdMode = "secondary",
  layout = "inline",
  className,
  dataRole,
}: {
  roleId?: string | null;
  roleName?: string | null;
  lookup?: Map<string, WorkerReferenceEntry>;
  onOpenRole?: ((roleId: string) => void) | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
  dataRole?: string;
}) {
  return (
    <EntityReference
      className={className}
      dataRole={dataRole}
      label={roleName ?? (roleId ? lookup?.get(roleId)?.label : null) ?? roleId ?? null}
      layout={layout}
      onOpen={roleId && onOpenRole ? () => onOpenRole(roleId) : null}
      rawId={roleId}
      rawIdMode={rawIdMode}
    />
  );
}

export function WorkerReferenceLink({
  workerType,
  workerId,
  workerName,
  agentLookup,
  roleLookup,
  onOpenAgent,
  onOpenRole,
  rawIdMode = "secondary",
  layout = "inline",
  className,
}: {
  workerType?: string | null;
  workerId?: string | null;
  workerName?: string | null;
  agentLookup?: Map<string, WorkerReferenceEntry>;
  roleLookup?: Map<string, WorkerReferenceEntry>;
  onOpenAgent?: ((agentId: string) => void) | null;
  onOpenRole?: ((roleId: string) => void) | null;
  rawIdMode?: RawIdMode;
  layout?: EntityReferenceLayout;
  className?: string;
}) {
  if (workerType === "agent") {
    return (
      <span className={joinTitles(className)}>
        <span className="entity-reference__prefix">Agent</span>
        <AgentReferenceLink
          agentId={workerId}
          agentName={workerName}
          className={className}
          layout={layout}
          lookup={agentLookup}
          onOpenAgent={onOpenAgent}
          rawIdMode={rawIdMode}
        />
      </span>
    );
  }

  if (workerType === "role") {
    return (
      <span className={joinTitles(className)}>
        <span className="entity-reference__prefix">Role</span>
        <RoleReferenceLink
          className={className}
          layout={layout}
          lookup={roleLookup}
          onOpenRole={onOpenRole}
          rawIdMode={rawIdMode}
          roleId={workerId}
          roleName={workerName}
        />
      </span>
    );
  }

  return <span>{workerType ?? "worker"}{workerId ? ` · ${workerId}` : ""}</span>;
}
