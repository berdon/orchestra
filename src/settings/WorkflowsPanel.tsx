import { useEffect, useMemo, useState } from "react";

import {
  archiveWorkflow,
  createWorkflow,
  duplicateWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  validateWorkflow,
} from "../lib/tauri";
import type { WorkflowDefinition, WorkflowLaneInput, WorkflowSummary, WorkflowUpsertInput, WorkflowValidationError } from "../types";

function createEmptyLane(order: number): WorkflowLaneInput {
  return {
    id: `lane-${Math.random().toString(36).slice(2, 8)}`,
    key: "",
    name: "",
    order,
    assignedEntityType: "user",
    assignedEntityId: null,
    entryPromptTemplate: null,
    successTargetLaneId: null,
    failureTargetLaneId: null,
    userInterventionTargetLaneId: null,
  };
}

function createBlankWorkflowDraft(): WorkflowUpsertInput {
  return {
    name: "",
    description: "",
    lanes: [createEmptyLane(0)],
  };
}

function workflowToDraft(workflow: WorkflowDefinition): WorkflowUpsertInput {
  return {
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
        successTargetLaneId: lane.successTargetLaneId ?? "",
        failureTargetLaneId: lane.failureTargetLaneId ?? "",
        userInterventionTargetLaneId: lane.userInterventionTargetLaneId ?? "",
      })),
  };
}

function getWorkflowValidationForPath(errors: WorkflowValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

export function WorkflowsPanel() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
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

  const selectedWorkflowSummary = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? workflows[0] ?? null,
    [selectedWorkflowId, workflows],
  );

  const laneIdOptions = useMemo(
    () => workflowDraft.lanes.map((lane) => ({ id: lane.id ?? "", label: lane.name.trim() || lane.key.trim() || lane.id || "Unnamed lane" })),
    [workflowDraft.lanes],
  );

  const validationSummary = useMemo(() => workflowValidation.map((error) => `${error.path}: ${error.message}`), [workflowValidation]);

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
      setWorkflowDraft(workflowToDraft(workflow));
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

  useEffect(() => {
    void loadWorkflows();
  }, [includeArchivedWorkflows]);

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
      const next = updater(current);
      void refreshWorkflowValidation(next);
      return next;
    });
  }

  function beginCreateWorkflow() {
    setSelectedWorkflowId(null);
    setWorkflowDraft(createBlankWorkflowDraft());
    setWorkflowValidation([]);
    setWorkflowActionError(null);
    setLoadedWorkflowId(null);
    setLoadedWorkflowArchived(false);
    setIsCreatingWorkflow(true);
  }

  async function handleSaveWorkflow() {
    setSavingWorkflow(true);
    setWorkflowActionError(null);

    try {
      const validation = await validateWorkflow(workflowDraft);
      setWorkflowValidation(validation.errors);
      if (!validation.valid) {
        setWorkflowActionError("Fix the workflow validation errors before saving.");
        return;
      }

      const saved = loadedWorkflowId && !isCreatingWorkflow
        ? await updateWorkflow(loadedWorkflowId, workflowDraft)
        : await createWorkflow(workflowDraft);

      await loadWorkflows();
      setSelectedWorkflowId(saved.id);
      setLoadedWorkflowId(saved.id);
      setLoadedWorkflowArchived(saved.archived);
      setWorkflowDraft(workflowToDraft(saved));
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

  return (
    <section className="workflow-shell">
      <aside className="panel workflow-list-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Workflow library</p>
            <h3>Workflows</h3>
          </div>
          <div className="action-cluster">
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

        <button className="primary-button" type="button" onClick={beginCreateWorkflow}>
          New workflow
        </button>

        {loadingWorkflows ? <p className="muted-copy">Loading workflows…</p> : null}
        {workflowActionError ? <p className="error-copy">{workflowActionError}</p> : null}

        <div className="workflow-list" role="list">
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={workflow.id === selectedWorkflowId && !isCreatingWorkflow ? "workflow-list-item workflow-list-item--active" : "workflow-list-item"}
              type="button"
              onClick={() => {
                setSelectedWorkflowId(workflow.id);
                setIsCreatingWorkflow(false);
              }}
            >
              <div className="workflow-list-item__header">
                <strong>{workflow.name}</strong>
                <span className={`status-badge status-badge--${workflow.archived ? "neutral" : "accent"}`}>
                  {workflow.archived ? "Archived" : "Active"}
                </span>
              </div>
              <div className="workflow-list-item__meta">
                <span>{workflow.slug}</span>
                <span>{workflow.laneCount} lanes</span>
              </div>
              <div className="workflow-list-item__footer">
                <span>{workflow.description || "No description"}</span>
                <span>{new Date(workflow.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="panel workflow-editor-panel">
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

          <div className="action-cluster">
            <button className="secondary-button" type="button" disabled={savingWorkflow || !selectedWorkflowSummary} onClick={() => void handleDuplicateWorkflow()}>
              Duplicate
            </button>
            <button className="secondary-button" type="button" disabled={savingWorkflow || !selectedWorkflowSummary || loadedWorkflowArchived} onClick={() => void handleArchiveWorkflow()}>
              Archive
            </button>
            <button className="primary-button" type="button" disabled={savingWorkflow || loadingWorkflowDetail} onClick={() => void handleSaveWorkflow()}>
              {savingWorkflow ? "Saving…" : loadedWorkflowId && !isCreatingWorkflow ? "Save changes" : "Create workflow"}
            </button>
          </div>
        </div>

        {loadingWorkflowDetail ? <p className="muted-copy">Loading workflow…</p> : null}

        <div className="workflow-editor-grid">
          <section className="workflow-section">
            <div className="workflow-section__header">
              <div>
                <p className="eyebrow">Workflow metadata</p>
                <h4>Basics</h4>
              </div>
            </div>

            <div className="workflow-form-grid">
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
                  className="text-area"
                  rows={3}
                  value={workflowDraft.description ?? ""}
                  onChange={(event) => updateWorkflowDraft((draft) => ({ ...draft, description: event.target.value }))}
                />
              </label>
            </div>
          </section>

          <section className="workflow-section">
            <div className="workflow-section__header">
              <div>
                <p className="eyebrow">Ordered lanes</p>
                <h4>Lane setup</h4>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={() =>
                  updateWorkflowDraft((draft) => ({
                    ...draft,
                    lanes: [...draft.lanes, createEmptyLane(draft.lanes.length)].map((lane, index) => ({ ...lane, order: index })),
                  }))
                }
              >
                Add lane
              </button>
            </div>

            {getWorkflowValidationForPath(workflowValidation, "lanes").map((error) => (
              <p className="field-error" key={error.message}>{error.message}</p>
            ))}

            <div className="workflow-lane-list">
              {workflowDraft.lanes.map((lane, index) => (
                <article className="workflow-lane-card" key={lane.id ?? `lane-${index}`}>
                  <div className="workflow-lane-card__header">
                    <div>
                      <p className="eyebrow">Lane {index + 1}</p>
                      <h4>{lane.name.trim() || lane.key.trim() || "Untitled lane"}</h4>
                    </div>
                    <div className="action-cluster">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={index === 0}
                        onClick={() =>
                          updateWorkflowDraft((draft) => {
                            const lanes = [...draft.lanes];
                            [lanes[index - 1], lanes[index]] = [lanes[index]!, lanes[index - 1]!];
                            return { ...draft, lanes: lanes.map((entry, order) => ({ ...entry, order })) };
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={index === workflowDraft.lanes.length - 1}
                        onClick={() =>
                          updateWorkflowDraft((draft) => {
                            const lanes = [...draft.lanes];
                            [lanes[index], lanes[index + 1]] = [lanes[index + 1]!, lanes[index]!];
                            return { ...draft, lanes: lanes.map((entry, order) => ({ ...entry, order })) };
                          })
                        }
                      >
                        ↓
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={workflowDraft.lanes.length <= 1}
                        onClick={() =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.filter((_, laneIndex) => laneIndex !== index).map((entry, order) => ({ ...entry, order })),
                          }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="workflow-form-grid">
                    <label className="field-group">
                      <span className="field-group__label">Lane name</span>
                      <input
                        className="text-input"
                        type="text"
                        value={lane.name}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, name: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].name`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">Lane key</span>
                      <input
                        className="text-input"
                        type="text"
                        value={lane.key}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, key: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].key`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">Owner type</span>
                      <select
                        className="select-input"
                        value={lane.assignedEntityType}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index
                                ? {
                                    ...entry,
                                    assignedEntityType: event.target.value,
                                    assignedEntityId: event.target.value === "user" ? "" : entry.assignedEntityId,
                                  }
                                : entry,
                            ),
                          }))
                        }
                      >
                        <option value="user">User</option>
                        <option value="agent">Agent</option>
                        <option value="role">Role</option>
                      </select>
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].assignedEntityType`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">Owner reference</span>
                      <input
                        className="text-input"
                        type="text"
                        placeholder={lane.assignedEntityType === "user" ? "Not used for user lanes" : "e.g. reviewer-role"}
                        value={lane.assignedEntityId ?? ""}
                        disabled={lane.assignedEntityType === "user"}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, assignedEntityId: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].assignedEntityId`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group workflow-form-grid__full">
                      <span className="field-group__label">Entry prompt template</span>
                      <textarea
                        className="text-area"
                        rows={3}
                        value={lane.entryPromptTemplate ?? ""}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, entryPromptTemplate: event.target.value } : entry,
                            ),
                          }))
                        }
                      />
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">On success</span>
                      <select
                        className="select-input"
                        value={lane.successTargetLaneId ?? ""}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, successTargetLaneId: event.target.value } : entry,
                            ),
                          }))
                        }
                      >
                        <option value="">End workflow</option>
                        {laneIdOptions
                          .filter((option) => option.id !== lane.id)
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                      </select>
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].successTargetLaneId`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">On failure</span>
                      <select
                        className="select-input"
                        value={lane.failureTargetLaneId ?? ""}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, failureTargetLaneId: event.target.value } : entry,
                            ),
                          }))
                        }
                      >
                        <option value="">End workflow</option>
                        {laneIdOptions
                          .filter((option) => option.id !== lane.id)
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                      </select>
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].failureTargetLaneId`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>

                    <label className="field-group">
                      <span className="field-group__label">Needs user intervention</span>
                      <select
                        className="select-input"
                        value={lane.userInterventionTargetLaneId ?? ""}
                        onChange={(event) =>
                          updateWorkflowDraft((draft) => ({
                            ...draft,
                            lanes: draft.lanes.map((entry, laneIndex) =>
                              laneIndex === index ? { ...entry, userInterventionTargetLaneId: event.target.value } : entry,
                            ),
                          }))
                        }
                      >
                        <option value="">End workflow</option>
                        {laneIdOptions
                          .filter((option) => option.id !== lane.id)
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                      </select>
                      {getWorkflowValidationForPath(workflowValidation, `lanes[${index}].userInterventionTargetLaneId`).map((error) => (
                        <span className="field-error" key={error.message}>{error.message}</span>
                      ))}
                    </label>
                  </div>
                </article>
              ))}
            </div>
          </section>

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
        </div>
      </section>
    </section>
  );
}
