import { useEffect, useMemo, useRef, useState } from "react";

import { MarkdownContent } from "../components/MarkdownContent";
import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { listAgents } from "../lib/agents";
import { listProjects } from "../lib/projects";
import { listRoles } from "../lib/roles";
import {
  archiveLocalSkill,
  createLocalSkill,
  deleteLocalSkill,
  getSkill,
  listSkills,
  refreshExternalSkills,
  setSkillBindings,
  unarchiveLocalSkill,
  updateLocalSkill,
} from "../lib/skills";
import {
  buildLocalSkillDraftState,
  buildSkillBindingDraft,
  createBlankLocalSkillDraft,
  createBlankSkillBindingDraft,
  filterSkillBindingTargets,
  filterSkills,
  localSkillDraftHasChanges,
  localSkillDraftHasContent,
  normalizeLocalSkillDraftForSave,
  normalizeSkillBindingDraftForSave,
  setSkillBindingDraftGlobal,
  skillBindingDraftHasChanges,
  validateSkillBindingDraft,
  type SkillBindingDraft,
  type SkillSourceFilter,
  type SkillStatusFilter,
} from "../lib/skillsUi";
import { getWorkflow, listWorkflows } from "../lib/tauri";
import type {
  AgentSummary,
  LocalSkillUpsertInput,
  ProjectSummary,
  RoleSummary,
  SkillBindingRecord,
  SkillBindingScopeCount,
  SkillDetail,
  SkillStatus,
  SkillSummary,
  WorkflowDefinition,
} from "../types";

const SOURCE_FILTER_OPTIONS: Array<{ value: SkillSourceFilter; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "external", label: "External" },
];

const STATUS_FILTER_OPTIONS: Array<{ value: SkillStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "shadowed", label: "Shadowed" },
  { value: "missing", label: "Missing" },
  { value: "invalid", label: "Invalid" },
];

function getSkillStatusLabel(status: SkillStatus) {
  switch (status) {
    case "unloadable":
      return "Unloadable";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function getSkillStatusBadgeClass(status: SkillStatus) {
  switch (status) {
    case "active":
      return "status-badge status-badge--success";
    case "shadowed":
    case "missing":
      return "status-badge status-badge--warning";
    case "invalid":
    case "unloadable":
      return "status-badge status-badge--error";
    default:
      return "status-badge status-badge--neutral";
  }
}

function getBindingScopeLabel(scopeKind: SkillBindingScopeCount["scopeKind"]) {
  switch (scopeKind) {
    case "workflow_lane":
      return "Workflow lane";
    default:
      return scopeKind.charAt(0).toUpperCase() + scopeKind.slice(1);
  }
}

function getSkillListMeta(skill: SkillSummary) {
  if (skill.sourceKind === "local") {
    return skill.slug ? `Slug: ${skill.slug}` : "Local skill";
  }

  return skill.relativeSourcePath ?? skill.sourcePath;
}

function describeBindingRecord(binding: SkillBindingRecord) {
  switch (binding.scopeKind) {
    case "global":
      return "Global";
    case "project":
      return binding.projectName ?? binding.projectSlug ?? binding.projectId ?? "Missing project";
    case "role":
      return binding.roleName ?? binding.roleSlug ?? binding.roleId ?? "Missing role";
    case "agent":
      return binding.agentName ?? binding.agentSlug ?? binding.agentId ?? "Missing agent";
    case "workflow":
      return binding.workflowName ?? binding.workflowSlug ?? binding.workflowId ?? "Missing workflow";
    case "workflow_lane":
      return [binding.workflowName ?? binding.workflowSlug ?? binding.workflowId ?? "Missing workflow", binding.workflowLaneName ?? binding.workflowLaneKey ?? binding.workflowLaneId ?? "Missing lane"].join(" → ");
    default:
      return binding.scopeKind;
  }
}

function renderSelectorResults<T extends { id: string; name: string; slug?: string | null }>(
  entries: T[],
  selectedIds: string[],
  query: string,
  onAdd: (id: string) => void,
  disabled: boolean,
  dataRolePrefix: string,
) {
  const filtered = filterSkillBindingTargets(entries, query)
    .filter((entry) => !selectedIds.includes(entry.id))
    .slice(0, 8);

  if (disabled) {
    return <p className="muted-copy">Disabled while the skill is globally assigned.</p>;
  }

  if (filtered.length === 0) {
    return <p className="muted-copy">No matching targets.</p>;
  }

  return (
    <div className="skills-binding-picker-list">
      {filtered.map((entry) => (
        <button
          className="secondary-button secondary-button--compact"
          data-role={`${dataRolePrefix}-${entry.id}`}
          key={entry.id}
          type="button"
          onClick={() => onAdd(entry.id)}
        >
          Add {entry.name}
        </button>
      ))}
    </div>
  );
}

interface SkillsPanelProps {
  selectionRequest?: { skillId: string; token: number } | null;
}

export function SkillsPanel({ selectionRequest = null }: SkillsPanelProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<SkillDetail | null>(null);
  const [localDraft, setLocalDraft] = useState<LocalSkillUpsertInput>(createBlankLocalSkillDraft);
  const [bindingDraft, setBindingDraft] = useState<SkillBindingDraft>(createBlankSkillBindingDraft);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const [roleSearchQuery, setRoleSearchQuery] = useState("");
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [workflowSearchQuery, setWorkflowSearchQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingBindingTargets, setLoadingBindingTargets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingBindings, setSavingBindings] = useState(false);
  const [refreshingExternal, setRefreshingExternal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bindingTargetError, setBindingTargetError] = useState<string | null>(null);
  const [isCreatingLocalSkill, setIsCreatingLocalSkill] = useState(false);
  const [deleteConfirmationRequired, setDeleteConfirmationRequired] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const selectionRequestTokenRef = useRef<number>(0);

  const localDraftState = useMemo(() => buildLocalSkillDraftState(localDraft), [localDraft]);
  const selectedExternalSkill = !isCreatingLocalSkill && selectedSkillDetail?.sourceKind === "external"
    ? selectedSkillDetail
    : null;
  const selectedLocalSkill = !isCreatingLocalSkill && selectedSkillDetail?.sourceKind === "local"
    ? selectedSkillDetail
    : null;
  const filteredSkills = useMemo(
    () => filterSkills(skills, { query: searchQuery, source: sourceFilter, status: statusFilter }),
    [searchQuery, skills, sourceFilter, statusFilter],
  );
  const skillsById = useMemo(
    () => new Map(skills.map((skill) => [skill.id, skill] as const)),
    [skills],
  );
  const localDraftIsDirty = useMemo(
    () => (isCreatingLocalSkill ? localSkillDraftHasContent(localDraft) : localSkillDraftHasChanges(localDraft, selectedLocalSkill)),
    [isCreatingLocalSkill, localDraft, selectedLocalSkill],
  );
  const currentDetail = isCreatingLocalSkill ? null : selectedSkillDetail;
  const selectedLocalSkillHasBindings = (selectedLocalSkill?.bindingSummary.totalCount ?? 0) > 0;
  const bindingDraftIsDirty = useMemo(
    () => (!isCreatingLocalSkill && currentDetail ? skillBindingDraftHasChanges(bindingDraft, currentDetail) : false),
    [bindingDraft, currentDetail, isCreatingLocalSkill],
  );

  async function loadSkillCatalog(preferredSkillId?: string | null) {
    setLoadingList(true);
    setActionError(null);

    try {
      const nextSkills = await listSkills(true);
      setSkills(nextSkills);
      if (isCreatingLocalSkill) {
        return;
      }

      setSelectedSkillId((current) => {
        const candidate = preferredSkillId === undefined ? current : preferredSkillId;
        if (candidate && nextSkills.some((skill) => skill.id === candidate)) {
          return candidate;
        }
        return nextSkills[0]?.id ?? null;
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to load skills.");
    } finally {
      setLoadingList(false);
    }
  }

  async function loadBindingTargets() {
    setLoadingBindingTargets(true);
    setBindingTargetError(null);

    try {
      const [nextProjects, nextRoles, nextAgents, workflowSummaries] = await Promise.all([
        listProjects(),
        listRoles(true),
        listAgents(true),
        listWorkflows(true),
      ]);
      const workflowDetails = await Promise.all(workflowSummaries.map((workflow) => getWorkflow(workflow.id)));
      setProjects(nextProjects);
      setRoles(nextRoles);
      setAgents(nextAgents);
      setWorkflows(workflowDetails);
    } catch (error) {
      setBindingTargetError(error instanceof Error ? error.message : "Unable to load binding targets.");
    } finally {
      setLoadingBindingTargets(false);
    }
  }

  useEffect(() => {
    void loadSkillCatalog();
    void loadBindingTargets();
  }, []);

  useEffect(() => {
    if (isCreatingLocalSkill) {
      setSelectedSkillDetail(null);
      return;
    }

    if (!selectedSkillId) {
      setSelectedSkillDetail(null);
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    setSelectedSkillDetail(null);
    setActionError(null);
    setDeleteConfirmationRequired(false);

    void getSkill(selectedSkillId)
      .then((detail) => {
        if (cancelled) {
          return;
        }
        applySelectedSkillDetail(detail);
      })
      .catch((error) => {
        if (!cancelled) {
          setActionError(error instanceof Error ? error.message : "Unable to load skill detail.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detailReloadKey, isCreatingLocalSkill, selectedSkillId]);

  useEffect(() => {
    if (!selectionRequest || selectionRequest.token === selectionRequestTokenRef.current) {
      return;
    }

    selectionRequestTokenRef.current = selectionRequest.token;
    setSourceFilter("all");
    setStatusFilter("all");
    setSearchQuery("");
    setIsCreatingLocalSkill(false);
    setSelectedSkillId(selectionRequest.skillId);
  }, [selectionRequest]);

  function applySelectedSkillDetail(detail: SkillDetail | null) {
    setSelectedSkillDetail(detail);
    setBindingDraft(buildSkillBindingDraft(detail));
    if (detail?.sourceKind === "local") {
      setLocalDraft({
        name: detail.name,
        slug: detail.slug ?? "",
        markdownBody: detail.markdownBody ?? "",
      });
    }
  }

  function reloadSelectedSkillDetail() {
    setDetailReloadKey((current) => current + 1);
  }

  function confirmDiscardDirtyDraft() {
    if (!localDraftIsDirty && !bindingDraftIsDirty) {
      return true;
    }

    return window.confirm("Discard unsaved skill or assignment changes?");
  }

  function beginCreateLocalSkill() {
    if (!confirmDiscardDirtyDraft()) {
      return;
    }

    setActionError(null);
    setDeleteConfirmationRequired(false);
    setIsCreatingLocalSkill(true);
    setSelectedSkillId(null);
    setSelectedSkillDetail(null);
    setLocalDraft(createBlankLocalSkillDraft());
    setBindingDraft(createBlankSkillBindingDraft());
  }

  function handleSelectSkill(skillId: string) {
    if (skillId === selectedSkillId && !isCreatingLocalSkill) {
      return;
    }

    if (!confirmDiscardDirtyDraft()) {
      return;
    }

    setActionError(null);
    setDeleteConfirmationRequired(false);
    setIsCreatingLocalSkill(false);
    setSelectedSkillId(skillId);
  }

  async function handleSaveSkill() {
    const fieldErrors = Object.values(localDraftState.validationErrors).filter(Boolean);
    if (fieldErrors.length > 0) {
      setActionError(fieldErrors[0] ?? "Unable to save skill.");
      return;
    }

    const input = normalizeLocalSkillDraftForSave(localDraft);
    setSaving(true);
    setActionError(null);

    try {
      const saved = isCreatingLocalSkill
        ? await createLocalSkill(input)
        : selectedLocalSkill
          ? await updateLocalSkill(selectedLocalSkill.id, input)
          : null;

      if (!saved) {
        throw new Error("Select a local skill before saving changes.");
      }

      setIsCreatingLocalSkill(false);
      setDeleteConfirmationRequired(false);
      applySelectedSkillDetail(saved);
      await loadSkillCatalog(saved.id);
      setSelectedSkillId(saved.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save skill.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveAssignments() {
    if (!currentDetail) {
      return;
    }

    const validationErrors = validateSkillBindingDraft(bindingDraft);
    if (validationErrors.length > 0) {
      setActionError(validationErrors[0] ?? "Unable to save skill assignments.");
      return;
    }

    setSavingBindings(true);
    setActionError(null);
    try {
      const saved = await setSkillBindings(currentDetail.id, normalizeSkillBindingDraftForSave(bindingDraft));
      applySelectedSkillDetail(saved);
      await loadSkillCatalog(saved.id);
      setSelectedSkillId(saved.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save skill assignments.");
    } finally {
      setSavingBindings(false);
    }
  }

  async function handleArchiveToggle(nextArchived: boolean) {
    if (!selectedLocalSkill) {
      return;
    }

    setSaving(true);
    setActionError(null);
    try {
      const updated = nextArchived
        ? await archiveLocalSkill(selectedLocalSkill.id)
        : await unarchiveLocalSkill(selectedLocalSkill.id);
      applySelectedSkillDetail(updated);
      await loadSkillCatalog(updated.id);
      setSelectedSkillId(updated.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Unable to ${nextArchived ? "archive" : "unarchive"} skill.`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSkill() {
    if (!selectedLocalSkill) {
      return;
    }

    if (selectedLocalSkillHasBindings) {
      setDeleteConfirmationRequired(false);
      setActionError("Clear all scope bindings before deleting this skill.");
      return;
    }

    if (!deleteConfirmationRequired) {
      setDeleteConfirmationRequired(true);
      return;
    }

    setSaving(true);
    setActionError(null);
    try {
      await deleteLocalSkill(selectedLocalSkill.id);
      setDeleteConfirmationRequired(false);
      setSelectedSkillId(null);
      setSelectedSkillDetail(null);
      await loadSkillCatalog();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete skill.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshExternalSkills() {
    setRefreshingExternal(true);
    setActionError(null);
    try {
      await refreshExternalSkills();
      await loadSkillCatalog(selectedSkillId);
      if (selectedSkillId && !isCreatingLocalSkill) {
        reloadSelectedSkillDetail();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to refresh external skills.");
    } finally {
      setRefreshingExternal(false);
    }
  }

  const detailWarnings = useMemo(() => {
    if (!selectedExternalSkill) {
      return [] as Array<{ tone: "neutral" | "warning" | "error"; title: string; message: string }>;
    }

    const warnings: Array<{ tone: "neutral" | "warning" | "error"; title: string; message: string }> = [
      {
        tone: "neutral",
        title: "Read-only external skill",
        message: "External skills come from ~/.agents/skills and cannot be edited in Orchestra Settings.",
      },
    ];

    if (selectedExternalSkill.status === "shadowed") {
      const shadowWinner = selectedExternalSkill.shadowedBySkillId ? skillsById.get(selectedExternalSkill.shadowedBySkillId) ?? null : null;
      warnings.push({
        tone: "warning",
        title: "Shadowed by another skill",
        message: shadowWinner
          ? `${shadowWinner.name} currently takes precedence for this slug.`
          : selectedExternalSkill.statusReason ?? "Another skill currently takes precedence for this slug.",
      });
    }

    if (selectedExternalSkill.status === "missing") {
      warnings.push({
        tone: "warning",
        title: "Missing on disk",
        message: "This external skill directory was indexed previously but is no longer present on disk.",
      });
    }

    if (selectedExternalSkill.status === "invalid" || selectedExternalSkill.status === "unloadable") {
      warnings.push({
        tone: "error",
        title: selectedExternalSkill.status === "invalid" ? "Invalid external skill" : "Unreadable external skill",
        message: selectedExternalSkill.statusReason ?? "Orchestra could not validate this external skill.",
      });
    }

    return warnings;
  }, [selectedExternalSkill, skillsById]);

  const selectedProjectEntries = useMemo(
    () => projects.filter((project) => bindingDraft.projectIds.includes(project.id)),
    [bindingDraft.projectIds, projects],
  );
  const selectedRoleEntries = useMemo(
    () => roles.filter((role) => bindingDraft.roleIds.includes(role.id)),
    [bindingDraft.roleIds, roles],
  );
  const selectedAgentEntries = useMemo(
    () => agents.filter((agent) => bindingDraft.agentIds.includes(agent.id)),
    [agents, bindingDraft.agentIds],
  );
  const selectedWorkflowEntries = useMemo(
    () => workflows.filter((workflow) => bindingDraft.workflowIds.includes(workflow.id)),
    [bindingDraft.workflowIds, workflows],
  );

  function updateIdList(
    scope: "projectIds" | "roleIds" | "agentIds" | "workflowIds",
    id: string,
    action: "add" | "remove",
  ) {
    setBindingDraft((current) => ({
      ...current,
      [scope]: action === "add"
        ? Array.from(new Set([...current[scope], id]))
        : current[scope].filter((entry) => entry !== id),
    }));
  }

  function updateLaneBinding(index: number, next: Partial<{ workflowId: string; workflowLaneId: string }>) {
    setBindingDraft((current) => ({
      ...current,
      workflowLaneBindings: current.workflowLaneBindings.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }
        const workflowId = next.workflowId ?? row.workflowId;
        return {
          workflowId,
          workflowLaneId: next.workflowId && next.workflowId !== row.workflowId ? "" : (next.workflowLaneId ?? row.workflowLaneId),
        };
      }),
    }));
  }

  function addLaneBindingRow() {
    setBindingDraft((current) => ({
      ...current,
      workflowLaneBindings: [...current.workflowLaneBindings, { workflowId: "", workflowLaneId: "" }],
    }));
  }

  function removeLaneBindingRow(index: number) {
    setBindingDraft((current) => ({
      ...current,
      workflowLaneBindings: current.workflowLaneBindings.filter((_, rowIndex) => rowIndex !== index),
    }));
  }

  function handleGlobalToggle(nextChecked: boolean) {
    if (nextChecked && !bindingDraft.global) {
      const hasScopedBindings = bindingDraft.projectIds.length > 0
        || bindingDraft.roleIds.length > 0
        || bindingDraft.agentIds.length > 0
        || bindingDraft.workflowIds.length > 0
        || bindingDraft.workflowLaneBindings.length > 0;
      if (hasScopedBindings && !window.confirm("Enabling the global assignment will clear the narrower scope bindings in this draft. Continue?")) {
        return;
      }
    }

    setBindingDraft((current) => setSkillBindingDraftGlobal(current, nextChecked));
  }

  function workflowLanesFor(workflowId: string) {
    const workflow = workflows.find((entry) => entry.id === workflowId) ?? null;
    return workflow?.lanes.slice().sort((left, right) => left.order - right.order) ?? [];
  }

  function renderBindingAssignmentSection(detail: SkillDetail) {
    return (
      <section className="workflow-section">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Assignments</p>
            <h3>Scope bindings</h3>
          </div>
          <button className="primary-button" data-role="save-skill-bindings" type="button" onClick={() => void handleSaveAssignments()} disabled={savingBindings || loadingDetail}>
            {savingBindings ? "Saving…" : "Save assignments"}
          </button>
        </div>

        <div className="skills-binding-summary" data-role="skill-bindings-summary">
          {detail.bindingSummary.totalCount > 0 ? (
            <>
              <span className="status-badge status-badge--accent">{detail.bindingSummary.totalCount} binding{detail.bindingSummary.totalCount === 1 ? "" : "s"}</span>
              {detail.bindingSummary.scopeCounts.map((scopeCount) => (
                <span className="status-badge status-badge--neutral" key={scopeCount.scopeKind}>
                  {getBindingScopeLabel(scopeCount.scopeKind)} · {scopeCount.count}
                </span>
              ))}
            </>
          ) : (
            <p className="muted-copy">No bindings yet.</p>
          )}
        </div>

        <div className="skills-binding-editor">
          <label className="checkbox-row skills-binding-global-toggle">
            <input data-role="skill-binding-global-toggle" type="checkbox" checked={bindingDraft.global} onChange={(event) => handleGlobalToggle(event.target.checked)} />
            <span>
              <strong>Global assignment</strong>
              <span className="field-group__hint">Global is mutually exclusive with project, role, agent, workflow, and lane bindings.</span>
            </span>
          </label>

          {loadingBindingTargets ? <p className="muted-copy">Loading assignment targets…</p> : null}
          {bindingTargetError ? <p className="error-copy">{bindingTargetError}</p> : null}

          <div className="skills-binding-grid">
            <div className="task-history-card skills-binding-card">
              <div>
                <p className="eyebrow">Projects</p>
                <h4>Project scope</h4>
              </div>
              <label className="field-group field-group--compact">
                <span className="field-group__label">Search projects</span>
                <input className="text-input" data-role="skill-project-search" type="search" value={projectSearchQuery} onChange={(event) => setProjectSearchQuery(event.target.value)} />
              </label>
              <div className="skills-binding-chip-list">
                {selectedProjectEntries.length > 0 ? selectedProjectEntries.map((project) => (
                  <span className="task-tag-chip" key={project.id}>
                    <button className="task-tag-chip__action" type="button">{project.name}</button>
                    <button className="task-tag-chip__remove" data-role={`remove-project-binding-${project.id}`} type="button" onClick={() => updateIdList("projectIds", project.id, "remove")} disabled={bindingDraft.global}>×</button>
                  </span>
                )) : <span className="muted-copy">No project bindings selected.</span>}
              </div>
              {renderSelectorResults(projects, bindingDraft.projectIds, projectSearchQuery, (id) => updateIdList("projectIds", id, "add"), bindingDraft.global, "add-project-binding")}
            </div>

            <div className="task-history-card skills-binding-card">
              <div>
                <p className="eyebrow">Roles</p>
                <h4>Role scope</h4>
              </div>
              <label className="field-group field-group--compact">
                <span className="field-group__label">Search roles</span>
                <input className="text-input" data-role="skill-role-search" type="search" value={roleSearchQuery} onChange={(event) => setRoleSearchQuery(event.target.value)} />
              </label>
              <div className="skills-binding-chip-list">
                {selectedRoleEntries.length > 0 ? selectedRoleEntries.map((role) => (
                  <span className="task-tag-chip" key={role.id}>
                    <button className="task-tag-chip__action" type="button">{role.name}</button>
                    <button className="task-tag-chip__remove" data-role={`remove-role-binding-${role.id}`} type="button" onClick={() => updateIdList("roleIds", role.id, "remove")} disabled={bindingDraft.global}>×</button>
                  </span>
                )) : <span className="muted-copy">No role bindings selected.</span>}
              </div>
              {renderSelectorResults(roles, bindingDraft.roleIds, roleSearchQuery, (id) => updateIdList("roleIds", id, "add"), bindingDraft.global, "add-role-binding")}
            </div>

            <div className="task-history-card skills-binding-card">
              <div>
                <p className="eyebrow">Agents</p>
                <h4>Agent scope</h4>
              </div>
              <label className="field-group field-group--compact">
                <span className="field-group__label">Search agents</span>
                <input className="text-input" data-role="skill-agent-search" type="search" value={agentSearchQuery} onChange={(event) => setAgentSearchQuery(event.target.value)} />
              </label>
              <div className="skills-binding-chip-list">
                {selectedAgentEntries.length > 0 ? selectedAgentEntries.map((agent) => (
                  <span className="task-tag-chip" key={agent.id}>
                    <button className="task-tag-chip__action" type="button">{agent.name}</button>
                    <button className="task-tag-chip__remove" data-role={`remove-agent-binding-${agent.id}`} type="button" onClick={() => updateIdList("agentIds", agent.id, "remove")} disabled={bindingDraft.global}>×</button>
                  </span>
                )) : <span className="muted-copy">No agent bindings selected.</span>}
              </div>
              {renderSelectorResults(agents, bindingDraft.agentIds, agentSearchQuery, (id) => updateIdList("agentIds", id, "add"), bindingDraft.global, "add-agent-binding")}
            </div>

            <div className="task-history-card skills-binding-card">
              <div>
                <p className="eyebrow">Workflows</p>
                <h4>Workflow scope</h4>
              </div>
              <label className="field-group field-group--compact">
                <span className="field-group__label">Search workflows</span>
                <input className="text-input" data-role="skill-workflow-search" type="search" value={workflowSearchQuery} onChange={(event) => setWorkflowSearchQuery(event.target.value)} />
              </label>
              <div className="skills-binding-chip-list">
                {selectedWorkflowEntries.length > 0 ? selectedWorkflowEntries.map((workflow) => (
                  <span className="task-tag-chip" key={workflow.id}>
                    <button className="task-tag-chip__action" type="button">{workflow.name}</button>
                    <button className="task-tag-chip__remove" data-role={`remove-workflow-binding-${workflow.id}`} type="button" onClick={() => updateIdList("workflowIds", workflow.id, "remove")} disabled={bindingDraft.global}>×</button>
                  </span>
                )) : <span className="muted-copy">No workflow bindings selected.</span>}
              </div>
              {renderSelectorResults(workflows, bindingDraft.workflowIds, workflowSearchQuery, (id) => updateIdList("workflowIds", id, "add"), bindingDraft.global, "add-workflow-binding")}
            </div>
          </div>

          <div className="task-history-card skills-binding-card skills-binding-card--full">
            <div className="workflow-section__header">
              <div>
                <p className="eyebrow">Workflow lanes</p>
                <h4>Lane scope</h4>
              </div>
              <button className="secondary-button secondary-button--compact" data-role="add-lane-binding" type="button" onClick={addLaneBindingRow} disabled={bindingDraft.global}>
                Add lane binding
              </button>
            </div>
            {bindingDraft.workflowLaneBindings.length > 0 ? (
              <div className="skills-lane-binding-list">
                {bindingDraft.workflowLaneBindings.map((row, index) => {
                  const laneOptions = workflowLanesFor(row.workflowId);
                  return (
                    <div className="skills-lane-binding-row" data-role="skill-lane-binding-row" key={`${index}-${row.workflowId}-${row.workflowLaneId}`}>
                      <label className="field-group field-group--compact">
                        <span className="field-group__label">Workflow</span>
                        <select className="select-input" data-role={`lane-binding-workflow-${index}`} value={row.workflowId} onChange={(event) => updateLaneBinding(index, { workflowId: event.target.value })} disabled={bindingDraft.global}>
                          <option value="">Select a workflow</option>
                          {workflows.map((workflow) => (
                            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field-group field-group--compact">
                        <span className="field-group__label">Lane</span>
                        <select className="select-input" data-role={`lane-binding-lane-${index}`} value={row.workflowLaneId} onChange={(event) => updateLaneBinding(index, { workflowLaneId: event.target.value })} disabled={bindingDraft.global || !row.workflowId}>
                          <option value="">Select a lane</option>
                          {laneOptions.map((lane) => (
                            <option key={lane.id} value={lane.id}>{lane.name || lane.key}</option>
                          ))}
                        </select>
                      </label>
                      <button className="secondary-button secondary-button--danger secondary-button--compact" data-role={`remove-lane-binding-${index}`} type="button" onClick={() => removeLaneBindingRow(index)} disabled={bindingDraft.global}>
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted-copy">No lane bindings selected.</p>
            )}
          </div>

          <div className="task-history-card skills-binding-card skills-binding-card--full">
            <div>
              <p className="eyebrow">Saved direct bindings</p>
              <h4>Audit view</h4>
            </div>
            {detail.bindings.length > 0 ? (
              <div className="skills-binding-chip-list">
                {detail.bindings.map((binding) => (
                  <span className="status-badge status-badge--neutral" key={binding.id}>
                    {getBindingScopeLabel(binding.scopeKind)} · {describeBindingRecord(binding)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No persisted bindings yet.</p>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <ResizableSidebarLayout
      className="skills-shell"
      storageKey="orchestra.layout.skills.secondary-nav-width"
      navigationClassName="skills-nav-panel"
      detailClassName="panel skills-detail-panel"
      navigation={(
        <>
          <div className="panel__header panel__header--stacked">
            <div>
              <p className="eyebrow">Managed skills catalog</p>
              <h3>Skills</h3>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" data-role="refresh-external-skills" type="button" onClick={() => void handleRefreshExternalSkills()} disabled={refreshingExternal || saving || savingBindings}>
                {refreshingExternal ? "Refreshing…" : "Refresh external"}
              </button>
              <button className="primary-button" data-role="new-skill" type="button" onClick={beginCreateLocalSkill} disabled={saving || savingBindings}>
                New local skill
              </button>
            </div>
          </div>

          <div className="skills-filter-grid">
            <label className="field-group field-group--compact">
              <span className="field-group__label">Search</span>
              <input
                className="text-input"
                data-role="skills-search"
                type="search"
                placeholder="Search by name or slug"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <label className="field-group field-group--compact">
              <span className="field-group__label">Source</span>
              <select className="select-input" data-role="skills-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SkillSourceFilter)}>
                {SOURCE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="field-group field-group--compact">
              <span className="field-group__label">Status</span>
              <select className="select-input" data-role="skills-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SkillStatusFilter)}>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {loadingList ? <p className="muted-copy">Loading skills…</p> : null}
          {actionError ? <p className="error-copy">{actionError}</p> : null}

          <nav className="skills-list" aria-label="Skills" data-role="skills-list">
            {filteredSkills.length === 0 ? (
              <div className="skills-list-empty muted-copy">
                No skills match the current filters.
              </div>
            ) : filteredSkills.map((skill) => {
              const selected = !isCreatingLocalSkill && skill.id === selectedSkillId;
              return (
                <button
                  className={selected ? "skills-list-item skills-list-item--active" : "skills-list-item"}
                  data-role={`skill-row-${skill.id}`}
                  key={skill.id}
                  type="button"
                  onClick={() => handleSelectSkill(skill.id)}
                >
                  <div className="skills-list-item__header">
                    <strong>{skill.name}</strong>
                    <div className="skills-list-item__badges">
                      <span className={skill.sourceKind === "local" ? "status-badge status-badge--accent" : "status-badge status-badge--neutral"}>
                        {skill.sourceKind === "local" ? "Local" : "External"}
                      </span>
                      {skill.sourceKind === "external" ? <span className="status-badge status-badge--neutral">Read-only</span> : null}
                      {skill.archived ? <span className="status-badge status-badge--neutral">Archived</span> : null}
                      {!skill.archived ? <span className={getSkillStatusBadgeClass(skill.status)}>{getSkillStatusLabel(skill.status)}</span> : null}
                    </div>
                  </div>
                  <span className="skills-list-item__meta">{getSkillListMeta(skill)}</span>
                  {skill.description ? <span className="skills-list-item__description">{skill.description}</span> : null}
                </button>
              );
            })}
          </nav>
        </>
      )}
      detail={(
        isCreatingLocalSkill ? (
          <div className="workflow-editor-grid" data-role="skill-detail">
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Local skill</p>
                <h3>Create skill</h3>
              </div>
              <div className="action-cluster action-cluster--wrap">
                <span className="status-badge status-badge--accent">Local draft</span>
                <button className="primary-button" data-role="save-skill" type="button" onClick={() => void handleSaveSkill()} disabled={saving}>
                  {saving ? "Creating…" : "Create skill"}
                </button>
              </div>
            </div>

            <section className="workflow-section skills-form-section">
              <div>
                <p className="eyebrow">Phase 1 editor</p>
                <h3>Name and markdown</h3>
              </div>

              <div className="skills-form-grid">
                <label className="field-group">
                  <span className="field-group__label">Skill name</span>
                  <input className="text-input" data-role="skill-name" type="text" value={localDraft.name} onChange={(event) => setLocalDraft((draft) => ({ ...draft, name: event.target.value }))} />
                  {localDraftState.validationErrors.name ? <span className="field-error">{localDraftState.validationErrors.name}</span> : null}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Slug</span>
                  <input className="text-input" data-role="skill-slug" type="text" placeholder="Leave blank to derive from the name" value={localDraft.slug ?? ""} onChange={(event) => setLocalDraft((draft) => ({ ...draft, slug: event.target.value }))} />
                  <span className="field-group__hint">{localDraftState.normalizedSlug ? `Saved as ${localDraftState.normalizedSlug}` : localDraftState.slugPreview ? `Will derive ${localDraftState.slugPreview}` : "A slug will be derived from the skill name."}</span>
                  {localDraftState.validationErrors.slug ? <span className="field-error">{localDraftState.validationErrors.slug}</span> : null}
                </label>

                <label className="field-group skills-form-grid__full">
                  <span className="field-group__label">Markdown body</span>
                  <textarea className="text-area skills-markdown-input" data-role="skill-markdown-body" rows={18} value={localDraft.markdownBody} onChange={(event) => setLocalDraft((draft) => ({ ...draft, markdownBody: event.target.value }))} />
                  <span className="field-group__hint">The editor stays phase-1 scoped to name, slug, and markdown content only.</span>
                  {localDraftState.validationErrors.markdownBody ? <span className="field-error">{localDraftState.validationErrors.markdownBody}</span> : null}
                </label>
              </div>
            </section>

            <section className="workflow-section">
              <div>
                <p className="eyebrow">Derived preview</p>
                <h3>Description</h3>
              </div>
              <div className="task-history-card skills-derived-preview" data-role="skill-description-preview">
                <strong>{localDraftState.descriptionPreview ? "First non-empty paragraph" : "No description available yet"}</strong>
                <p>{localDraftState.descriptionPreview ?? "Add markdown content to preview the derived description that the catalog will store."}</p>
              </div>
            </section>
          </div>
        ) : currentDetail ? (
          currentDetail.sourceKind === "local" ? (
            <div className="workflow-editor-grid" data-role="skill-detail">
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">Local skill</p>
                  <h3>{currentDetail.name}</h3>
                </div>
                <div className="action-cluster action-cluster--wrap">
                  <span className="status-badge status-badge--accent">Local</span>
                  {currentDetail.archived ? <span className="status-badge status-badge--neutral">Archived</span> : <span className={getSkillStatusBadgeClass(currentDetail.status)}>{getSkillStatusLabel(currentDetail.status)}</span>}
                  <button className="secondary-button" data-role={currentDetail.archived ? "unarchive-skill" : "archive-skill"} type="button" onClick={() => void handleArchiveToggle(!currentDetail.archived)} disabled={saving || savingBindings}>
                    {currentDetail.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role="delete-skill"
                    type="button"
                    onClick={() => void handleDeleteSkill()}
                    disabled={saving || savingBindings || selectedLocalSkillHasBindings}
                    title={selectedLocalSkillHasBindings ? "Clear all scope bindings before deleting this skill." : undefined}
                  >
                    {deleteConfirmationRequired ? "Confirm delete" : "Delete"}
                  </button>
                  <button className="primary-button" data-role="save-skill" type="button" onClick={() => void handleSaveSkill()} disabled={saving || loadingDetail || savingBindings}>
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>

              {loadingDetail ? <p className="muted-copy">Loading skill…</p> : null}

              <section className="workflow-section skills-form-section">
                <div>
                  <p className="eyebrow">Phase 1 editor</p>
                  <h3>Name and markdown</h3>
                </div>

                <div className="skills-form-grid">
                  <label className="field-group">
                    <span className="field-group__label">Skill name</span>
                    <input className="text-input" data-role="skill-name" type="text" value={localDraft.name} onChange={(event) => setLocalDraft((draft) => ({ ...draft, name: event.target.value }))} />
                    {localDraftState.validationErrors.name ? <span className="field-error">{localDraftState.validationErrors.name}</span> : null}
                  </label>

                  <label className="field-group">
                    <span className="field-group__label">Slug</span>
                    <input className="text-input" data-role="skill-slug" type="text" placeholder="Leave blank to derive from the name" value={localDraft.slug ?? ""} onChange={(event) => setLocalDraft((draft) => ({ ...draft, slug: event.target.value }))} />
                    <span className="field-group__hint">{localDraftState.normalizedSlug ? `Saved as ${localDraftState.normalizedSlug}` : localDraftState.slugPreview ? `Will derive ${localDraftState.slugPreview}` : "A slug will be derived from the skill name."}</span>
                    {localDraftState.validationErrors.slug ? <span className="field-error">{localDraftState.validationErrors.slug}</span> : null}
                  </label>

                  <label className="field-group skills-form-grid__full">
                    <span className="field-group__label">Markdown body</span>
                    <textarea className="text-area skills-markdown-input" data-role="skill-markdown-body" rows={18} value={localDraft.markdownBody} onChange={(event) => setLocalDraft((draft) => ({ ...draft, markdownBody: event.target.value }))} />
                    <span className="field-group__hint">The editor stays phase-1 scoped to name, slug, and markdown content only.</span>
                    {localDraftState.validationErrors.markdownBody ? <span className="field-error">{localDraftState.validationErrors.markdownBody}</span> : null}
                  </label>
                </div>
              </section>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Derived preview</p>
                  <h3>Description</h3>
                </div>
                <div className="task-history-card skills-derived-preview" data-role="skill-description-preview">
                  <strong>{localDraftState.descriptionPreview ? "First non-empty paragraph" : "No description available yet"}</strong>
                  <p>{localDraftState.descriptionPreview ?? "Add markdown content to preview the derived description that the catalog will store."}</p>
                </div>
              </section>

              {renderBindingAssignmentSection(currentDetail)}

              {selectedLocalSkillHasBindings ? (
                <p className="muted-copy" data-role="skill-delete-blocked-hint">Clear all scope bindings before deleting this skill.</p>
              ) : null}
            </div>
          ) : (
            <div className="workflow-editor-grid" data-role="skill-detail">
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">External skill</p>
                  <h3>{currentDetail.name}</h3>
                </div>
                <div className="action-cluster action-cluster--wrap">
                  <span className="status-badge status-badge--neutral">External</span>
                  <span className="status-badge status-badge--neutral">Read-only content</span>
                  {currentDetail.archived ? <span className="status-badge status-badge--neutral">Archived</span> : <span className={getSkillStatusBadgeClass(currentDetail.status)}>{getSkillStatusLabel(currentDetail.status)}</span>}
                </div>
              </div>

              <div className="skills-warning-stack">
                {detailWarnings.map((warning) => (
                  <div className={`skills-warning skills-warning--${warning.tone}`} key={`${warning.title}-${warning.message}`}>
                    <strong>{warning.title}</strong>
                    <p>{warning.message}</p>
                  </div>
                ))}
              </div>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Source</p>
                  <h3>Discovery paths</h3>
                </div>
                <dl className="skills-path-list">
                  <div>
                    <dt>Relative source</dt>
                    <dd>{currentDetail.relativeSourcePath ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Source path</dt>
                    <dd>{currentDetail.sourcePath}</dd>
                  </div>
                  <div>
                    <dt>Content path</dt>
                    <dd>{currentDetail.contentPath}</dd>
                  </div>
                </dl>
              </section>

              {renderBindingAssignmentSection(currentDetail)}

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">SKILL.md preview</p>
                  <h3>Read-only markdown</h3>
                </div>
                {currentDetail.markdownBody ? (
                  <div className="task-history-card skills-markdown-preview-shell">
                    <MarkdownContent dataRole="skill-markdown-preview" message={currentDetail.markdownBody} />
                  </div>
                ) : (
                  <div className="task-history-card skills-markdown-preview-shell" data-role="skill-markdown-preview-empty">
                    <strong>Markdown preview unavailable</strong>
                    <p>The SKILL.md file is currently unavailable, so Orchestra cannot render a read-only preview.</p>
                  </div>
                )}
              </section>
            </div>
          )
        ) : loadingDetail ? (
          <div className="empty-state" data-role="skill-empty-state">
            <h3>Loading skill</h3>
            <p>Fetching the selected skill details…</p>
          </div>
        ) : (
          <div className="empty-state" data-role="skill-empty-state">
            <h3>Select a skill</h3>
            <p>Browse the catalog on the left to inspect an existing local or external skill, or create a new local skill.</p>
          </div>
        )
      )}
    />
  );
}
