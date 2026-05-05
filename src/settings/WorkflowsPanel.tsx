import { useEffect, useMemo, useRef, useState } from "react";

import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SettingsMobileSubnavHeader } from "../components/SettingsMobileSubnavHeader";
import { SettingsSectionTabs } from "../components/SettingsSectionTabs";
import { listAgents } from "../lib/agents";
import { listRoles } from "../lib/roles";
import { getWorkflowSkillLinks } from "../lib/skills";
import {
  archiveWorkflow,
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflow,
  getWorkflowDeleteImpact,
  listWorkflows,
  updateWorkflow,
  validateWorkflow,
} from "../lib/tauri";
import type {
  AgentSummary,
  RoleSummary,
  WorkflowDefinition,
  WorkflowDeleteImpact,
  WorkflowLaneInput,
  WorkflowSkillLinks,
  WorkflowSummary,
  WorkflowTransitionType,
  WorkflowUpsertInput,
  WorkflowValidationError,
} from "../types";

function createEmptyLane(order: number): WorkflowLaneInput {
  return {
    id: `lane-${Math.random().toString(36).slice(2, 8)}`,
    key: "",
    name: "",
    order,
    assignedEntityType: "user",
    assignedEntityId: null,
    entryPromptTemplate: null,
    requireUserApprovalOnSuccess: false,
    needsWorkTargetLaneId: null,
    successTransitionType: "end",
    successTargetLaneId: null,
    failureTransitionType: "end",
    failureTargetLaneId: null,
  };
}

function applyEditorWorkflowRules(input: WorkflowUpsertInput): WorkflowUpsertInput {
  const lanes = input.lanes.map((lane, index, allLanes) => {
    const nextLane = allLanes[index + 1];
    return {
      ...lane,
      order: index,
      needsWorkTargetLaneId: lane.requireUserApprovalOnSuccess ? (lane.needsWorkTargetLaneId ?? null) : null,
      successTransitionType: (nextLane ? "lane" : "end") satisfies WorkflowTransitionType,
      successTargetLaneId: nextLane?.id ?? null,
    };
  });

  return {
    ...input,
    lanes,
  };
}

function createBlankWorkflowDraft(): WorkflowUpsertInput {
  return applyEditorWorkflowRules({
    name: "",
    description: "",
    lanes: [createEmptyLane(0)],
  });
}

function workflowToDraft(workflow: WorkflowDefinition): WorkflowUpsertInput {
  return applyEditorWorkflowRules({
    name: workflow.name,
    description: workflow.description ?? "",
    lanes: workflow.lanes
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((lane, index) => ({
        id: lane.id,
        key: lane.key,
        name: lane.name,
        description: lane.description ?? "",
        order: index,
        assignedEntityType: lane.assignedEntityType,
        assignedEntityId: lane.assignedEntityId ?? "",
        entryPromptTemplate: lane.entryPromptTemplate ?? "",
        requireUserApprovalOnSuccess: lane.requireUserApprovalOnSuccess ?? false,
        needsWorkTargetLaneId: lane.needsWorkTargetLaneId ?? "",
        successTransitionType: lane.successTransitionType,
        successTargetLaneId: lane.successTargetLaneId ?? "",
        failureTransitionType: lane.failureTransitionType,
        failureTargetLaneId: lane.failureTargetLaneId ?? "",
      })),
  });
}

function getWorkflowValidationForPath(errors: WorkflowValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

function formatLaneLabel(lane: WorkflowLaneInput, index: number) {
  return lane.name.trim() || lane.key.trim() || `Lane ${index + 1}`;
}

function describeFailure(lane: WorkflowLaneInput, laneOptions: Array<{ id: string; label: string }>) {
  if (lane.failureTransitionType === "user_intervention") {
    return "Requires user intervention";
  }

  if (lane.failureTransitionType === "lane") {
    return laneOptions.find((option) => option.id === lane.failureTargetLaneId)?.label ?? "Go to lane";
  }

  return "Ends workflow";
}

function describeNeedsWorkTarget(lane: WorkflowLaneInput, laneOptions: Array<{ id: string; label: string }>) {
  if (!lane.requireUserApprovalOnSuccess) {
    return null;
  }

  return laneOptions.find((option) => option.id === lane.needsWorkTargetLaneId)?.label ?? "Resume current lane/session";
}

function buildOwnerOptions<T extends { slug: string; name: string }>(entries: T[]) {
  return entries.map((entry) => ({ value: entry.slug, label: entry.name }));
}

function describeOwner(
  lane: WorkflowLaneInput,
  agentOptions: Array<{ value: string; label: string }>,
  roleOptions: Array<{ value: string; label: string }>,
) {
  if (lane.assignedEntityType === "user") {
    return {
      typeLabel: "Owner: User",
      referenceLabel: null,
    };
  }

  if (lane.assignedEntityType === "agent") {
    const agent = agentOptions.find((option) => option.value === lane.assignedEntityId);
    return {
      typeLabel: "Owner: Agent",
      referenceLabel: agent?.label ?? (lane.assignedEntityId ? `Missing agent: ${lane.assignedEntityId}` : "No agent selected"),
    };
  }

  const role = roleOptions.find((option) => option.value === lane.assignedEntityId);
  return {
    typeLabel: "Owner: Role",
    referenceLabel: role?.label ?? (lane.assignedEntityId ? `Missing role: ${lane.assignedEntityId}` : "No role selected"),
  };
}

interface WorkflowsPanelProps {
  activeProjectId?: string | null;
  selectionRequest?: { workflowId: string; token: number } | null;
  onOpenSkill?: (skillId: string) => void;
  canReadSkills?: boolean;
}

export function WorkflowsPanel({ activeProjectId = null, selectionRequest = null, onOpenSkill, canReadSkills = false }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState<WorkflowUpsertInput>(createBlankWorkflowDraft);
  const [workflowValidation, setWorkflowValidation] = useState<WorkflowValidationError[]>([]);
  const [workflowActionError, setWorkflowActionError] = useState<string | null>(null);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [loadingWorkflowDetail, setLoadingWorkflowDetail] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [includeArchivedWorkflows, setIncludeArchivedWorkflows] = useState(false);
  const [isCreatingWorkflow, setIsCreatingWorkflow] = useState(false);
  const [loadedWorkflowId, setLoadedWorkflowId] = useState<string | null>(null);
  const [loadedWorkflowArchived, setLoadedWorkflowArchived] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteImpact, setDeleteImpact] = useState<WorkflowDeleteImpact | null>(null);
  const [loadingDeleteImpact, setLoadingDeleteImpact] = useState(false);
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [skillLinks, setSkillLinks] = useState<WorkflowSkillLinks | null>(null);
  const selectionRequestTokenRef = useRef<number>(0);

  const selectedWorkflowSummary = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0] ?? null,
    [selectedWorkflowId, workflows],
  );

  const laneIdOptions = useMemo(
    () => workflowDraft.lanes.map((lane, index) => ({ id: lane.id ?? "", label: formatLaneLabel(lane, index) })),
    [workflowDraft.lanes],
  );
  const agentOptions = useMemo(() => buildOwnerOptions(agents), [agents]);
  const roleOptions = useMemo(() => buildOwnerOptions(roles), [roles]);

  const selectedLaneIndex = useMemo(
    () => workflowDraft.lanes.findIndex((lane) => lane.id === selectedLaneId),
    [selectedLaneId, workflowDraft.lanes],
  );

  const selectedLane = selectedLaneIndex >= 0 ? workflowDraft.lanes[selectedLaneIndex] ?? null : workflowDraft.lanes[0] ?? null;
  const selectedLaneSkillLinks = useMemo(
    () => skillLinks?.workflowLaneSkills.find((lane) => lane.workflowLaneId === selectedLane?.id) ?? null,
    [selectedLane?.id, skillLinks?.workflowLaneSkills],
  );

  const validationSummary = useMemo(() => workflowValidation.map((error) => `${error.path}: ${error.message}`), [workflowValidation]);
  const deleteImpactRows = useMemo(() => {
    if (!deleteImpact) {
      return [];
    }

    return [
      { label: "Tasks", count: deleteImpact.referenceCounts.tasks },
      { label: "Task schedules", count: deleteImpact.referenceCounts.taskSchedules },
      { label: "Task lane assignments", count: deleteImpact.referenceCounts.taskLaneAssignments },
      { label: "Role queue entries", count: deleteImpact.referenceCounts.roleQueueEntries },
      { label: "Agent queue entries", count: deleteImpact.referenceCounts.agentQueueEntries },
    ].filter((entry) => entry.count > 0);
  }, [deleteImpact]);

  function resetWorkflowEditor() {
    const nextDraft = createBlankWorkflowDraft();
    setWorkflowDraft(nextDraft);
    setSelectedLaneId(nextDraft.lanes[0]?.id ?? null);
    setWorkflowValidation([]);
    setLoadedWorkflowId(null);
    setLoadedWorkflowArchived(false);
    setIsCreatingWorkflow(false);
  }

  async function loadWorkflows() {
    setLoadingWorkflows(true);
    setWorkflowActionError(null);

    try {
      const nextWorkflows = await listWorkflows(includeArchivedWorkflows);
      setWorkflows(nextWorkflows);
      setSelectedWorkflowId((current) => {
        if (isCreatingWorkflow) {
          return current;
        }

        if (current && nextWorkflows.some((workflow) => workflow.id === current)) {
          return current;
        }

        return nextWorkflows[0]?.id ?? null;
      });
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to load workflows.");
    } finally {
      setLoadingWorkflows(false);
    }
  }

  async function loadWorkflowDetail(workflowId: string) {
    setLoadingWorkflowDetail(true);
    setWorkflowActionError(null);

    try {
      const workflow = await getWorkflow(workflowId);
      const nextDraft = workflowToDraft(workflow);
      setWorkflowDraft(nextDraft);
      setSelectedLaneId(nextDraft.lanes[0]?.id ?? null);
      setWorkflowValidation([]);
      setLoadedWorkflowId(workflow.id);
      setLoadedWorkflowArchived(workflow.archived);
      setIsCreatingWorkflow(false);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to load workflow.");
    } finally {
      setLoadingWorkflowDetail(false);
    }
  }

  async function loadAssignableWorkers() {
    try {
      const [nextAgents, nextRoles] = await Promise.all([listAgents(false, activeProjectId), listRoles()]);
      setAgents(nextAgents);
      setRoles(nextRoles);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to load lane owner options.");
    }
  }

  useEffect(() => {
    void loadWorkflows();
    void loadAssignableWorkers();
  }, [includeArchivedWorkflows, activeProjectId]);

  useEffect(() => {
    if (isCreatingWorkflow) {
      return;
    }

    const workflowId = selectedWorkflowSummary?.id;
    if (!workflowId || workflowId === loadedWorkflowId) {
      return;
    }

    void loadWorkflowDetail(workflowId);
  }, [selectedWorkflowSummary?.id, isCreatingWorkflow, loadedWorkflowId]);

  useEffect(() => {
    if (!selectionRequest || selectionRequest.token === selectionRequestTokenRef.current) {
      return;
    }

    selectionRequestTokenRef.current = selectionRequest.token;
    setIsCreatingWorkflow(false);
    setSelectedWorkflowId(selectionRequest.workflowId);
  }, [selectionRequest]);

  useEffect(() => {
    if (!canReadSkills || isCreatingWorkflow || !selectedWorkflowSummary?.id) {
      setSkillLinks(null);
      return;
    }

    let cancelled = false;
    void getWorkflowSkillLinks(selectedWorkflowSummary.id)
      .then((links) => {
        if (!cancelled) {
          setSkillLinks(links);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkflowActionError(error instanceof Error ? error.message : "Unable to load linked skills.");
          setSkillLinks(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canReadSkills, isCreatingWorkflow, selectedWorkflowSummary?.id]);

  async function refreshWorkflowValidation(nextDraft: WorkflowUpsertInput) {
    try {
      const validation = await validateWorkflow(nextDraft);
      setWorkflowValidation(validation.errors);
      return validation.errors;
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to validate workflow.");
      return [];
    }
  }

  function updateWorkflowDraft(updater: (draft: WorkflowUpsertInput) => WorkflowUpsertInput) {
    setWorkflowDraft((current) => {
      const next = applyEditorWorkflowRules(updater(current));
      if (!next.lanes.some((lane) => lane.id === selectedLaneId)) {
        setSelectedLaneId(next.lanes[0]?.id ?? null);
      }
      void refreshWorkflowValidation(next);
      return next;
    });
  }

  function beginCreateWorkflow() {
    const nextDraft = createBlankWorkflowDraft();
    setSelectedWorkflowId(null);
    setWorkflowDraft(nextDraft);
    setSelectedLaneId(nextDraft.lanes[0]?.id ?? null);
    setWorkflowValidation([]);
    setWorkflowActionError(null);
    setLoadedWorkflowId(null);
    setLoadedWorkflowArchived(false);
    setShowDeleteConfirm(false);
    setDeleteImpact(null);
    setIsCreatingWorkflow(true);
  }

  async function handleSaveWorkflow() {
    setSavingWorkflow(true);
    setWorkflowActionError(null);

    try {
      const normalizedDraft = applyEditorWorkflowRules(workflowDraft);
      const validation = await validateWorkflow(normalizedDraft);
      setWorkflowValidation(validation.errors);
      if (!validation.valid) {
        setWorkflowActionError("Fix the workflow validation errors before saving.");
        return;
      }

      const saved = loadedWorkflowId && !isCreatingWorkflow
        ? await updateWorkflow(loadedWorkflowId, normalizedDraft)
        : await createWorkflow(normalizedDraft);

      await loadWorkflows();
      const nextDraft = workflowToDraft(saved);
      setSelectedWorkflowId(saved.id);
      setLoadedWorkflowId(saved.id);
      setLoadedWorkflowArchived(saved.archived);
      setWorkflowDraft(nextDraft);
      setSelectedLaneId(nextDraft.lanes[0]?.id ?? null);
      setWorkflowValidation([]);
      setIsCreatingWorkflow(false);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to save workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function handleDuplicateWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setSavingWorkflow(true);
    setWorkflowActionError(null);
    try {
      const duplicated = await duplicateWorkflow(selectedWorkflowSummary.id);
      await loadWorkflows();
      setSelectedWorkflowId(duplicated.id);
      await loadWorkflowDetail(duplicated.id);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to duplicate workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function handleArchiveWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setSavingWorkflow(true);
    setWorkflowActionError(null);
    try {
      const archived = await archiveWorkflow(selectedWorkflowSummary.id);
      await loadWorkflows();
      setSelectedWorkflowId(archived.id);
      await loadWorkflowDetail(archived.id);
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to archive workflow.");
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function handleRequestDeleteWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setShowDeleteConfirm(true);
    setDeleteImpact(null);
    setLoadingDeleteImpact(true);
    setWorkflowActionError(null);

    try {
      const impact = await getWorkflowDeleteImpact(selectedWorkflowSummary.id);
      setDeleteImpact(impact);
    } catch (error) {
      setShowDeleteConfirm(false);
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to inspect workflow delete impact.");
    } finally {
      setLoadingDeleteImpact(false);
    }
  }

  async function handleConfirmDeleteWorkflow() {
    if (!selectedWorkflowSummary) {
      return;
    }

    setDeletingWorkflow(true);
    setWorkflowActionError(null);
    try {
      await deleteWorkflow(selectedWorkflowSummary.id);
      const nextWorkflows = await listWorkflows(includeArchivedWorkflows);
      const nextSelectedWorkflowId = nextWorkflows[0]?.id ?? null;
      setWorkflows(nextWorkflows);
      setSelectedWorkflowId(nextSelectedWorkflowId);
      setShowDeleteConfirm(false);
      setDeleteImpact(null);

      if (nextSelectedWorkflowId) {
        await loadWorkflowDetail(nextSelectedWorkflowId);
      } else {
        resetWorkflowEditor();
      }
    } catch (error) {
      setWorkflowActionError(error instanceof Error ? error.message : "Unable to delete workflow.");
    } finally {
      setDeletingWorkflow(false);
    }
  }

  return (
    <section className="panel-stack workflow-stack">
      <section className="panel workflow-board-panel">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Workflow preview</p>
            <h3>Lane board</h3>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              updateWorkflowDraft((draft) => {
                const nextLanes = [...draft.lanes, createEmptyLane(draft.lanes.length)];
                const nextDraft = { ...draft, lanes: nextLanes };
                setSelectedLaneId(nextLanes[nextLanes.length - 1]?.id ?? null);
                return nextDraft;
              })
            }
          >
            Add lane
          </button>
        </div>

        {getWorkflowValidationForPath(workflowValidation, "lanes").map((error) => (
          <p className="field-error" key={error.message}>{error.message}</p>
        ))}

        <div className="workflow-board" role="list" aria-label="Workflow lanes">
          {workflowDraft.lanes.map((lane, index) => {
            const nextLane = workflowDraft.lanes[index + 1];
            const isSelected = selectedLane?.id === lane.id;
            const owner = describeOwner(lane, agentOptions, roleOptions);
            return (
              <button
                key={lane.id ?? `lane-${index}`}
                type="button"
                className={isSelected ? "workflow-board-lane workflow-board-lane--active" : "workflow-board-lane"}
                onClick={() => setSelectedLaneId(lane.id ?? null)}
              >
                <div className="workflow-board-lane__header">
                  <span className="status-badge status-badge--accent">Lane {index + 1}</span>
                  <strong>{formatLaneLabel(lane, index)}</strong>
                </div>
                <div className="workflow-board-lane__meta">
                  <span>{owner.typeLabel}</span>
                  {owner.referenceLabel ? <span>{owner.referenceLabel}</span> : null}
                </div>
                <div className="workflow-board-lane__flow">
                  <span>Success → {nextLane ? formatLaneLabel(nextLane, index + 1) : "End"}</span>
                  <span>Failure → {describeFailure(lane, laneIdOptions)}</span>
                  {lane.requireUserApprovalOnSuccess ? <span>Success requires user approval</span> : null}
                  {describeNeedsWorkTarget(lane, laneIdOptions) ? <span>Needs Work → {describeNeedsWorkTarget(lane, laneIdOptions)}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <SettingsMobileSubnavHeader
        dataRolePrefix="workflow"
        selectLabel="Workflow"
        ariaLabel="Workflow selection"
        value={isCreatingWorkflow ? null : selectedWorkflowId}
        emptyOptionLabel={isCreatingWorkflow ? "New workflow" : "Select workflow"}
        options={workflows.map((workflow) => ({ id: workflow.id, label: workflow.name }))}
        onChange={(workflowId) => {
          if (workflowId) {
            setSelectedWorkflowId(workflowId);
            setIsCreatingWorkflow(false);
          }
        }}
        actions={[
          {
            id: "toggle-archived-workflows",
            label: includeArchivedWorkflows ? "Hide archived workflows" : "Show archived workflows",
            onClick: () => setIncludeArchivedWorkflows((current) => !current),
            variant: "secondary",
          },
          {
            id: "refresh-workflows",
            label: "Refresh workflows",
            onClick: () => void loadWorkflows(),
            variant: "secondary",
          },
          {
            id: "new-workflow",
            label: "New workflow",
            onClick: beginCreateWorkflow,
            variant: "secondary",
          },
          ...(selectedWorkflowSummary
            ? [{
                id: "duplicate-workflow",
                label: "Duplicate",
                onClick: () => void handleDuplicateWorkflow(),
                disabled: savingWorkflow || deletingWorkflow,
                variant: "secondary" as const,
              }, {
                id: "archive-workflow",
                label: "Archive",
                onClick: () => void handleArchiveWorkflow(),
                disabled: savingWorkflow || deletingWorkflow || loadedWorkflowArchived,
                variant: "secondary" as const,
              }, {
                id: "delete-workflow",
                label: "Delete",
                onClick: () => void handleRequestDeleteWorkflow(),
                disabled: savingWorkflow || deletingWorkflow || loadingDeleteImpact,
                variant: "danger" as const,
              }]
            : []),
          {
            id: "save-workflow",
            label: savingWorkflow ? "Saving…" : loadedWorkflowId && !isCreatingWorkflow ? "Save changes" : "Create workflow",
            onClick: () => void handleSaveWorkflow(),
            disabled: savingWorkflow || deletingWorkflow || loadingWorkflowDetail,
            variant: "primary",
          },
        ]}
        actionMenuLabel="Workflow actions"
      />

      <ResizableSidebarLayout
        className="workflow-shell"
        storageKey="orchestra.layout.workflows.secondary-nav-width"
        navigationClassName="workflow-nav-panel settings-mobile-subnav-panel"
        detailClassName="panel workflow-detail-panel"
        navigation={(
        <>
          <div className="panel__header panel__header--stacked">
            <div>
              <p className="eyebrow">Workflow library</p>
              <h3>Workflows</h3>
            </div>
            <div className="action-cluster settings-mobile-subnav-redundant-actions">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={includeArchivedWorkflows}
                  onChange={(event) => setIncludeArchivedWorkflows(event.target.checked)}
                />
                Show archived
              </label>
              <button className="secondary-button" type="button" onClick={() => void loadWorkflows()}>
                Refresh
              </button>
            </div>
          </div>

          <button className="primary-button settings-mobile-subnav-redundant-actions" type="button" onClick={beginCreateWorkflow}>
            New workflow
          </button>

          {loadingWorkflows ? <p className="muted-copy">Loading workflows…</p> : null}
          {workflowActionError ? <p className="error-copy">{workflowActionError}</p> : null}

          <nav className="workflow-nav settings-mobile-subnav-list" aria-label="Workflows">
            {workflows.map((workflow) => (
              <a
                key={workflow.id}
                className={workflow.id === selectedWorkflowId && !isCreatingWorkflow ? "workflow-nav-link workflow-nav-link--active" : "workflow-nav-link"}
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  setSelectedWorkflowId(workflow.id);
                  setIsCreatingWorkflow(false);
                }}
              >
                {workflow.name}
              </a>
            ))}
          </nav>
        </>
        )}
        detail={(
        <>
          <div className="panel__header panel__header--session-detail">
            <div>
              <p className="eyebrow">Workflow editor</p>
              <h3>{isCreatingWorkflow ? "New workflow" : selectedWorkflowSummary?.name ?? "Select a workflow"}</h3>
              <div className="session-detail__meta">
                {!isCreatingWorkflow && selectedWorkflowSummary ? (
                  <>
                    <span>{selectedWorkflowSummary.slug}</span>
                    <span>{selectedWorkflowSummary.laneCount} lanes</span>
                    <span>{loadedWorkflowArchived ? "Archived" : "Editable"}</span>
                  </>
                ) : (
                  <span>Structured workflow editor</span>
                )}
              </div>
            </div>

            <div className="action-cluster settings-mobile-subnav-redundant-actions">
              <button className="secondary-button" type="button" disabled={savingWorkflow || deletingWorkflow || !selectedWorkflowSummary} onClick={() => void handleDuplicateWorkflow()}>
                Duplicate
              </button>
              <button className="secondary-button" type="button" disabled={savingWorkflow || deletingWorkflow || !selectedWorkflowSummary || loadedWorkflowArchived} onClick={() => void handleArchiveWorkflow()}>
                Archive
              </button>
              <button className="secondary-button secondary-button--danger" data-role="delete-workflow" type="button" disabled={savingWorkflow || deletingWorkflow || loadingDeleteImpact || !selectedWorkflowSummary} onClick={() => void handleRequestDeleteWorkflow()}>
                Delete
              </button>
              <button className="primary-button" data-role="save-workflow" type="button" disabled={savingWorkflow || deletingWorkflow || loadingWorkflowDetail} onClick={() => void handleSaveWorkflow()}>
                {savingWorkflow ? "Saving…" : loadedWorkflowId && !isCreatingWorkflow ? "Save changes" : "Create workflow"}
              </button>
            </div>
          </div>

          {loadingWorkflowDetail ? <p className="muted-copy">Loading workflow…</p> : null}

          <SettingsSectionTabs
            className="workflow-editor-grid"
            ariaLabel="Workflow settings sections"
            dataRolePrefix="workflow-detail"
            initialTabId="basics"
            leadingContent={loadingWorkflowDetail ? <p className="muted-copy">Loading workflow…</p> : null}
            tabs={[
              {
                id: "basics",
                label: "Basics",
                panel: (
                  <section className="workflow-section workflow-section--compact">
                    <div className="workflow-section__header">
                      <div>
                        <p className="eyebrow">Workflow metadata</p>
                        <h4>Basics</h4>
                      </div>
                    </div>

                    <div className="workflow-form-grid workflow-form-grid--compact">
                      <label className="field-group">
                        <span className="field-group__label">Workflow name</span>
                        <input
                          className="text-input"
                          type="text"
                          value={workflowDraft.name}
                          onChange={(event) => updateWorkflowDraft((draft) => ({ ...draft, name: event.target.value }))}
                        />
                        {getWorkflowValidationForPath(workflowValidation, "name").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group workflow-form-grid__full">
                        <span className="field-group__label">Description</span>
                        <textarea
                          className="text-area text-area--compact"
                          rows={2}
                          value={workflowDraft.description ?? ""}
                          onChange={(event) => updateWorkflowDraft((draft) => ({ ...draft, description: event.target.value }))}
                        />
                      </label>
                    </div>
                  </section>
                ),
              },
              {
                id: "skills",
                label: "Skills",
                panel: canReadSkills ? (
                  <section className="workflow-section workflow-section--compact">
                    <div>
                      <p className="eyebrow">Managed skills</p>
                      <h4>Workflow-linked skills</h4>
                    </div>
                    {skillLinks?.workflowSkills.length ? (
                      <div className="skills-binding-chip-list">
                        {skillLinks.workflowSkills.map((skill) => (
                          onOpenSkill ? (
                            <button className="task-tag-chip task-tag-chip--interactive" data-role={`workflow-linked-skill-${skill.skillId}`} key={skill.bindingId} type="button" onClick={() => onOpenSkill(skill.skillId)}>
                              <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                            </button>
                          ) : (
                            <span className="task-tag-chip" data-role={`workflow-linked-skill-${skill.skillId}`} key={skill.bindingId}>
                              <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                            </span>
                          )
                        ))}
                      </div>
                    ) : (
                      <p className="muted-copy">No workflow-scoped skills are linked here. Edit assignments in Settings → Skills.</p>
                    )}
                  </section>
                ) : (
                  <section className="workflow-section workflow-section--compact">
                    <div>
                      <p className="eyebrow">Managed skills</p>
                      <h4>Workflow-linked skills</h4>
                    </div>
                    <p className="muted-copy">Managed skill links are unavailable with the current permissions.</p>
                  </section>
                ),
              },
              {
                id: "lane",
                label: "Lane",
                hidden: !selectedLane,
                panel: selectedLane ? (
                  <section className="workflow-section">
                    <div className="workflow-section__header">
                      <div>
                        <p className="eyebrow">Selected lane</p>
                        <h4>{formatLaneLabel(selectedLane, selectedLaneIndex >= 0 ? selectedLaneIndex : 0)}</h4>
                      </div>
                      <div className="action-cluster">
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={(selectedLaneIndex < 0 ? 0 : selectedLaneIndex) === 0}
                          onClick={() =>
                            updateWorkflowDraft((draft) => {
                              const index = draft.lanes.findIndex((lane) => lane.id === selectedLane.id);
                              if (index <= 0) {
                                return draft;
                              }
                              const lanes = [...draft.lanes];
                              [lanes[index - 1], lanes[index]] = [lanes[index]!, lanes[index - 1]!];
                              return { ...draft, lanes };
                            })
                          }
                        >
                          Move left
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={selectedLaneIndex < 0 || selectedLaneIndex === workflowDraft.lanes.length - 1}
                          onClick={() =>
                            updateWorkflowDraft((draft) => {
                              const index = draft.lanes.findIndex((lane) => lane.id === selectedLane.id);
                              if (index < 0 || index === draft.lanes.length - 1) {
                                return draft;
                              }
                              const lanes = [...draft.lanes];
                              [lanes[index], lanes[index + 1]] = [lanes[index + 1]!, lanes[index]!];
                              return { ...draft, lanes };
                            })
                          }
                        >
                          Move right
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={workflowDraft.lanes.length <= 1}
                          onClick={() =>
                            updateWorkflowDraft((draft) => {
                              const lanes = draft.lanes.filter((lane) => lane.id !== selectedLane.id);
                              return { ...draft, lanes };
                            })
                          }
                        >
                          Remove lane
                        </button>
                      </div>
                    </div>

                    {canReadSkills ? (
                      selectedLaneSkillLinks?.skills.length ? (
                        <div className="skills-binding-chip-list">
                          {selectedLaneSkillLinks.skills.map((skill) => (
                            onOpenSkill ? (
                              <button className="task-tag-chip task-tag-chip--interactive" data-role={`lane-linked-skill-${skill.skillId}`} key={skill.bindingId} type="button" onClick={() => onOpenSkill(skill.skillId)}>
                                <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                              </button>
                            ) : (
                              <span className="task-tag-chip" data-role={`lane-linked-skill-${skill.skillId}`} key={skill.bindingId}>
                                <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                              </span>
                            )
                          ))}
                        </div>
                      ) : (
                        <p className="muted-copy">No lane-scoped skills are linked to this lane. Edit assignments in Settings → Skills.</p>
                      )
                    ) : (
                      <p className="muted-copy">Managed skill links are unavailable with the current permissions.</p>
                    )}

                    <div className="workflow-form-grid">
                      <label className="field-group">
                        <span className="field-group__label">Lane name</span>
                        <input
                          className="text-input"
                          type="text"
                          value={selectedLane.name}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) =>
                                entry.id === selectedLane.id ? { ...entry, name: event.target.value } : entry,
                              ),
                            }))
                          }
                        />
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].name`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Lane key</span>
                        <input
                          className="text-input"
                          type="text"
                          value={selectedLane.key}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) =>
                                entry.id === selectedLane.id ? { ...entry, key: event.target.value } : entry,
                              ),
                            }))
                          }
                        />
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].key`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Owner type</span>
                        <select
                          className="select-input"
                          data-role="lane-owner-type"
                          value={selectedLane.assignedEntityType}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) => {
                                if (entry.id !== selectedLane.id) {
                                  return entry;
                                }

                                if (event.target.value === "user") {
                                  return {
                                    ...entry,
                                    assignedEntityType: "user",
                                    assignedEntityId: "",
                                    useSeparateWorktree: false,
                                    requireUserApprovalOnSuccess: false,
                                    needsWorkTargetLaneId: null,
                                  };
                                }

                                if (event.target.value === "agent") {
                                  return {
                                    ...entry,
                                    assignedEntityType: "agent",
                                    assignedEntityId: entry.assignedEntityType === "agent" ? entry.assignedEntityId : (agentOptions[0]?.value ?? ""),
                                  };
                                }

                                return {
                                  ...entry,
                                  assignedEntityType: "role",
                                  assignedEntityId: entry.assignedEntityType === "role" ? entry.assignedEntityId : (roleOptions[0]?.value ?? ""),
                                };
                              }),
                            }))
                          }
                        >
                          <option value="user">User</option>
                          <option value="agent">Agent</option>
                          <option value="role">Role</option>
                        </select>
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].assignedEntityType`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Owner reference</span>
                        {selectedLane.assignedEntityType === "user" ? (
                          <input className="text-input" type="text" placeholder="Not used for user lanes" value="" disabled />
                        ) : selectedLane.assignedEntityType === "agent" ? (
                          <select
                            className="select-input"
                            data-role="lane-owner-reference"
                            value={selectedLane.assignedEntityId ?? ""}
                            onChange={(event) =>
                              updateWorkflowDraft((draft) => ({
                                ...draft,
                                lanes: draft.lanes.map((entry) =>
                                  entry.id === selectedLane.id ? { ...entry, assignedEntityId: event.target.value } : entry,
                                ),
                              }))
                            }
                          >
                            <option value="">{agentOptions.length === 0 ? "No active agents available" : "Select an agent"}</option>
                            {agentOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            {selectedLane.assignedEntityId && !agentOptions.some((option) => option.value === selectedLane.assignedEntityId) ? (
                              <option value={selectedLane.assignedEntityId}>Missing agent: {selectedLane.assignedEntityId}</option>
                            ) : null}
                          </select>
                        ) : (
                          <select
                            className="select-input"
                            data-role="lane-owner-reference"
                            value={selectedLane.assignedEntityId ?? ""}
                            onChange={(event) =>
                              updateWorkflowDraft((draft) => ({
                                ...draft,
                                lanes: draft.lanes.map((entry) =>
                                  entry.id === selectedLane.id ? { ...entry, assignedEntityId: event.target.value } : entry,
                                ),
                              }))
                            }
                          >
                            <option value="">{roleOptions.length === 0 ? "No active roles available" : "Select a role"}</option>
                            {roleOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                            {selectedLane.assignedEntityId && !roleOptions.some((option) => option.value === selectedLane.assignedEntityId) ? (
                              <option value={selectedLane.assignedEntityId}>Missing role: {selectedLane.assignedEntityId}</option>
                            ) : null}
                          </select>
                        )}
                        {selectedLane.assignedEntityType === "role" && roleOptions.length === 0 ? (
                          <span className="muted-copy">Create a role in Settings → Roles before assigning this lane.</span>
                        ) : null}
                        {selectedLane.assignedEntityType === "agent" && agentOptions.length === 0 ? (
                          <span className="muted-copy">No active agents are available to own this lane yet.</span>
                        ) : null}
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].assignedEntityId`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group workflow-form-grid__full">
                        <span className="field-group__label">Entry prompt template</span>
                        <textarea
                          className="text-area"
                          rows={3}
                          value={selectedLane.entryPromptTemplate ?? ""}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) =>
                                entry.id === selectedLane.id ? { ...entry, entryPromptTemplate: event.target.value } : entry,
                              ),
                            }))
                          }
                        />
                      </label>

                      <div className="field-group workflow-form-grid__full">
                        <span className="field-group__label">Workspace</span>
                        <label className="checkbox-row">
                          <input
                            data-role="lane-use-separate-worktree"
                            type="checkbox"
                            checked={selectedLane.useSeparateWorktree ?? false}
                            disabled={selectedLane.assignedEntityType === "user"}
                            onChange={(event) =>
                              updateWorkflowDraft((draft) => ({
                                ...draft,
                                lanes: draft.lanes.map((entry) =>
                                  entry.id === selectedLane.id
                                    ? { ...entry, useSeparateWorktree: event.target.checked }
                                    : entry,
                                ),
                              }))
                            }
                          />
                          <span>Use a separate worker-specific worktree instead of the shared task worktree.</span>
                        </label>
                        {selectedLane.assignedEntityType === "user" ? (
                          <span className="muted-copy">User-owned lanes always operate without a dedicated worker worktree.</span>
                        ) : (
                          <span className="muted-copy">When off, agent and role lanes share the task worktree by default.</span>
                        )}
                      </div>

                      <div className="field-group workflow-form-grid__full">
                        <span className="field-group__label">Success review</span>
                        <label className="checkbox-row">
                          <input
                            data-role="lane-success-review-required"
                            type="checkbox"
                            checked={selectedLane.requireUserApprovalOnSuccess ?? false}
                            disabled={selectedLane.assignedEntityType === "user"}
                            onChange={(event) =>
                              updateWorkflowDraft((draft) => ({
                                ...draft,
                                lanes: draft.lanes.map((entry) =>
                                  entry.id === selectedLane.id
                                    ? {
                                        ...entry,
                                        requireUserApprovalOnSuccess: event.target.checked,
                                        needsWorkTargetLaneId: event.target.checked ? (entry.needsWorkTargetLaneId ?? "") : "",
                                      }
                                    : entry,
                                ),
                              }))
                            }
                          />
                          <span>Require user approval after success before the workflow continues.</span>
                        </label>
                        {selectedLane.assignedEntityType === "user" ? (
                          <span className="muted-copy">User-owned lanes do not support an extra approval gate.</span>
                        ) : null}
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].requireUserApprovalOnSuccess`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </div>

                      <div className="workflow-flow-note workflow-form-grid__full">
                        <p className="eyebrow">On success</p>
                        <strong>
                          {selectedLaneIndex >= 0 && workflowDraft.lanes[selectedLaneIndex + 1]
                            ? `Automatically continues to ${formatLaneLabel(workflowDraft.lanes[selectedLaneIndex + 1]!, selectedLaneIndex + 1)}`
                            : "Ends the workflow"}
                        </strong>
                        <p className="muted-copy">
                          The frontend keeps success aligned to the next lane in board order. Reorder the board to change the success path.
                        </p>
                      </div>

                      {selectedLane.requireUserApprovalOnSuccess ? (
                        <label className="field-group workflow-form-grid__full">
                          <span className="field-group__label">Needs Work target lane</span>
                          <select
                            className="select-input"
                            data-role="lane-needs-work-target"
                            value={selectedLane.needsWorkTargetLaneId ?? ""}
                            onChange={(event) =>
                              updateWorkflowDraft((draft) => ({
                                ...draft,
                                lanes: draft.lanes.map((entry) =>
                                  entry.id === selectedLane.id ? { ...entry, needsWorkTargetLaneId: event.target.value } : entry,
                                ),
                              }))
                            }
                          >
                            <option value="">Resume current lane/session (legacy default)</option>
                            {laneIdOptions
                              .filter((option) => option.id !== selectedLane.id)
                              .map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label}
                                </option>
                              ))}
                          </select>
                          <span className="muted-copy">When review sends work back, this lane is used instead of the legacy same-session resume behavior.</span>
                          {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].needsWorkTargetLaneId`).map((error) => (
                            <span className="field-error" key={error.message}>{error.message}</span>
                          ))}
                        </label>
                      ) : null}

                      <label className="field-group">
                        <span className="field-group__label">On failure</span>
                        <select
                          className="select-input"
                          value={selectedLane.failureTransitionType}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) =>
                                entry.id === selectedLane.id
                                  ? {
                                      ...entry,
                                      failureTransitionType: event.target.value,
                                      failureTargetLaneId: event.target.value === "lane" ? entry.failureTargetLaneId : "",
                                    }
                                  : entry,
                              ),
                            }))
                          }
                        >
                          <option value="end">End workflow</option>
                          <option value="lane">Go to lane</option>
                          <option value="user_intervention">Require user intervention</option>
                        </select>
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].failureTransitionType`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Failure target lane</span>
                        <select
                          className="select-input"
                          value={selectedLane.failureTargetLaneId ?? ""}
                          disabled={selectedLane.failureTransitionType !== "lane"}
                          onChange={(event) =>
                            updateWorkflowDraft((draft) => ({
                              ...draft,
                              lanes: draft.lanes.map((entry) =>
                                entry.id === selectedLane.id ? { ...entry, failureTargetLaneId: event.target.value } : entry,
                              ),
                            }))
                          }
                        >
                          <option value="">Choose lane</option>
                          {laneIdOptions
                            .filter((option) => option.id !== selectedLane.id)
                            .map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                        </select>
                        {getWorkflowValidationForPath(workflowValidation, `lanes[${selectedLaneIndex}].failureTargetLaneId`).map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>
                    </div>
                  </section>
                ) : null,
              },
              {
                id: "validation",
                label: "Validation",
                panel: (
                  <section className="workflow-section">
                    <div className="workflow-section__header">
                      <div>
                        <p className="eyebrow">Validation</p>
                        <h4>Save readiness</h4>
                      </div>
                    </div>

                    {validationSummary.length ? (
                      <ul className="workflow-validation-list">
                        {validationSummary.map((message) => (
                          <li key={message}>{message}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted-copy">No validation issues right now.</p>
                    )}
                  </section>
                ),
              },
            ]}
          />
        </>
        )}
      />

      {showDeleteConfirm ? (
        <div className="quick-chat-overlay" data-role="workflow-delete-confirm-overlay" onClick={() => !loadingDeleteImpact && !deletingWorkflow && setShowDeleteConfirm(false)}>
          <section className="quick-chat-modal panel task-delete-confirm" data-role="workflow-delete-confirm" onClick={(event) => event.stopPropagation()}>
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Delete workflow</p>
                <h3>Delete {selectedWorkflowSummary?.name ?? "workflow"}?</h3>
              </div>
            </div>

            {loadingDeleteImpact ? (
              <p>Loading delete impact…</p>
            ) : deleteImpact?.canDelete ? (
              <>
                <p>This permanently deletes the workflow definition and its lanes. This cannot be undone.</p>
                <p className="muted-copy">No tasks, schedules, or runtime records currently block this delete.</p>
              </>
            ) : (
              <>
                <p>This workflow is still referenced and cannot be permanently deleted safely.</p>
                {deleteImpactRows.length ? (
                  <ul className="workflow-validation-list" data-role="workflow-delete-impact-list">
                    {deleteImpactRows.map((entry) => (
                      <li key={entry.label}>{entry.label}: {entry.count}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="muted-copy">Archive the workflow instead if you want it out of normal use while keeping its historical references intact.</p>
              </>
            )}

            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" disabled={loadingDeleteImpact || deletingWorkflow} onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              {deleteImpact?.canDelete ? (
                <button className="secondary-button secondary-button--danger" data-role="confirm-delete-workflow" type="button" disabled={deletingWorkflow} onClick={() => void handleConfirmDeleteWorkflow()}>
                  {deletingWorkflow ? "Deleting…" : "Delete workflow"}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
