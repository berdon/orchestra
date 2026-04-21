import { useEffect, useMemo, useState } from "react";

import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import {
  attachRepositoryRemote,
  createProject,
  createRepository,
  deleteProject,
  deleteRepository,
  getProject,
  listProjects,
  setProjectDefaultRepository,
  updateProject,
  updateRepository,
} from "../lib/projects";
import {
  getTaskAutomationSettings,
  updateTaskAutomationSettings,
} from "../lib/projectSettings";
import type {
  ProjectDetail,
  ProjectSummary,
  ProjectTaskAutomationSettings,
  ProjectUpsertInput,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
} from "../types";

function createBlankProjectDraft(): ProjectUpsertInput {
  return { name: "", description: "" };
}

function createBlankRepositoryDraft(): RepositoryUpsertInput {
  return { name: "", mode: "existing", repositoryPath: "", defaultBranch: "main" };
}

function createBlankRemoteDraft(): RepositoryRemoteInput {
  return { remoteUrl: "", remoteName: "origin" };
}

export function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectUpsertInput>(createBlankProjectDraft);
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryUpsertInput>(createBlankRepositoryDraft);
  const [attachRemoteRepositoryId, setAttachRemoteRepositoryId] = useState<string | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<RepositoryRemoteInput>(createBlankRemoteDraft);
  const [taskAutomationSettings, setTaskAutomationSettings] = useState<ProjectTaskAutomationSettings | null>(null);
  const [autoDispatchOnBlockerCompletion, setAutoDispatchOnBlockerCompletion] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [deleteProjectConfirmationArmed, setDeleteProjectConfirmationArmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => (isCreatingProject ? null : projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null),
    [isCreatingProject, projects, selectedProjectId],
  );

  async function loadProjects() {
    setLoading(true);
    setError(null);
    try {
      const nextProjects = await listProjects();
      setProjects(nextProjects);
      setSelectedProjectId((current) => (current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? null));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load projects.");
    } finally {
      setLoading(false);
    }
  }

  async function loadProjectDetail(projectId: string) {
    setLoading(true);
    setError(null);
    try {
      const detail = await getProject(projectId);
      const automationSettings = await getTaskAutomationSettings(detail.slug);
      setProjectDetail(detail);
      setProjectDraft({ name: detail.name, description: detail.description ?? "" });
      setTaskAutomationSettings(automationSettings);
      setAutoDispatchOnBlockerCompletion(automationSettings.autoDispatchOnBlockerCompletion);
      setIsCreatingProject(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load project detail.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    setDeleteProjectConfirmationArmed(false);
    if (selectedProject?.id) {
      void loadProjectDetail(selectedProject.id);
    }
  }, [selectedProject?.id]);

  async function handleSaveProject() {
    setSaving(true);
    setError(null);
    try {
      const saved = selectedProject?.id && !isCreatingProject
        ? await updateProject(selectedProject.id, projectDraft)
        : await createProject(projectDraft);
      await loadProjects();
      setSelectedProjectId(saved.id);
      setIsCreatingProject(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to save project.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddRepository() {
    if (!selectedProject?.id) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await createRepository(selectedProject.id, repositoryDraft);
      setRepositoryDraft(createBlankRepositoryDraft());
      await loadProjectDetail(selectedProject.id);
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to add repository.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefaultRepository(repositoryId: string | null) {
    if (!selectedProject?.id) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await setProjectDefaultRepository(selectedProject.id, repositoryId);
      setProjectDetail(updated);
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to update default repository.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRepository(repositoryId: string, repositoryName: string) {
    if (!selectedProject?.id) {
      return;
    }

    const confirmed = window.confirm(`Delete repository "${repositoryName}" from project "${selectedProject.name}"?`);
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await deleteRepository(repositoryId);
      await loadProjectDetail(selectedProject.id);
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to delete repository.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAttachRemote(repositoryId: string) {
    if (!selectedProject?.id) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await attachRepositoryRemote(repositoryId, remoteDraft);
      setAttachRemoteRepositoryId(null);
      setRemoteDraft(createBlankRemoteDraft());
      await loadProjectDetail(selectedProject.id);
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to attach repository remote.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveTaskAutomationSettings() {
    if (!selectedProject) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await updateTaskAutomationSettings(
        autoDispatchOnBlockerCompletion,
        selectedProject.slug,
      );
      setTaskAutomationSettings(updated);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to update automation settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteProject() {
    if (!selectedProject?.id) {
      return;
    }

    if (!deleteProjectConfirmationArmed) {
      setDeleteProjectConfirmationArmed(true);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await deleteProject(selectedProject.id);
      setProjectDetail(null);
      setProjectDraft(createBlankProjectDraft());
      setRepositoryDraft(createBlankRepositoryDraft());
      setSelectedProjectId(null);
      setIsCreatingProject(false);
      setDeleteProjectConfirmationArmed(false);
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to delete project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResizableSidebarLayout
      className="task-shell"
      storageKey="orchestra.layout.projects.secondary-nav-width"
      navigationClassName="task-nav-panel"
      detailClassName="panel task-detail-panel"
      navigation={(
      <>
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Project catalog</p>
            <h3>Projects</h3>
            <p className="muted-copy">New installs start with a seeded Orchestra workspace. It is an ordinary project: you can rename it, add repositories, replace it, or delete it.</p>
          </div>
          <button className="primary-button" type="button" onClick={() => {
            setSelectedProjectId(null);
            setProjectDetail(null);
            setProjectDraft(createBlankProjectDraft());
            setRepositoryDraft(createBlankRepositoryDraft());
            setAttachRemoteRepositoryId(null);
            setRemoteDraft(createBlankRemoteDraft());
            setTaskAutomationSettings(null);
            setAutoDispatchOnBlockerCompletion(false);
            setIsCreatingProject(true);
          }}>
            New project
          </button>
        </div>

        {loading ? <p className="muted-copy">Loading projects…</p> : null}
        {error ? <p className="error-copy">{error}</p> : null}

        <nav className="task-list" aria-label="Projects">
          {projects.map((project) => (
            <a
              key={project.id}
              className={project.id === selectedProject?.id ? "task-list-link task-list-link--active" : "task-list-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedProjectId(project.id);
              }}
            >
              <span className="task-list-link__eyebrow">{project.slug}</span>
              <strong>{project.name}</strong>
            </a>
          ))}
        </nav>
      </>
      )}
      detail={(
      <>
        <div className="task-detail-stack">
          <div className="panel__header panel__header--session-detail">
            <div>
              <p className="eyebrow">Project detail</p>
              <h3>{selectedProject ? selectedProject.name : "New project"}</h3>
            </div>
            <div className="row-actions">
              {selectedProject ? (
                <>
                  <button
                    className={deleteProjectConfirmationArmed ? "secondary-button secondary-button--danger" : "secondary-button"}
                    data-role="delete-project"
                    data-confirmation-armed={deleteProjectConfirmationArmed ? "true" : "false"}
                    type="button"
                    disabled={saving}
                    onClick={() => void handleDeleteProject()}
                  >
                    {deleteProjectConfirmationArmed ? "Confirm delete" : "Delete project"}
                  </button>
                  {deleteProjectConfirmationArmed ? (
                    <button
                      className="secondary-button"
                      data-role="cancel-delete-project"
                      type="button"
                      disabled={saving}
                      onClick={() => setDeleteProjectConfirmationArmed(false)}
                    >
                      Cancel
                    </button>
                  ) : null}
                </>
              ) : null}
              <button className="primary-button" type="button" disabled={saving} onClick={() => void handleSaveProject()}>
                {saving ? "Saving…" : selectedProject ? "Save project" : "Create project"}
              </button>
            </div>
          </div>

          <div className="task-editor-grid">
            <label className="field-group">
              <span className="field-group__label">Name</span>
              <input className="text-input" data-role="project-name" value={projectDraft.name} onChange={(event) => setProjectDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="field-group task-editor-grid__full">
              <span className="field-group__label">Description</span>
              <textarea className="text-area" data-role="project-description" rows={4} value={projectDraft.description ?? ""} onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))} />
            </label>
          </div>

          {projectDetail ? (
            <section className="task-section task-section--compact" data-role="project-automation-settings">
              <div className="task-section__header">
                <div>
                  <p className="eyebrow">Automation</p>
                  <h4>Task dispatch</h4>
                  <p className="muted-copy">Automatically dispatch tasks when they become work-ready through creation or unblocking, including dependency and subtask blockers.</p>
                </div>
                <button
                  className="secondary-button"
                  data-role="save-project-automation-settings"
                  type="button"
                  disabled={saving || !selectedProject}
                  onClick={() => void handleSaveTaskAutomationSettings()}
                >
                  Save automation settings
                </button>
              </div>
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Enable auto task dispatching for newly work-ready tasks</span>
                <input
                  className="checkbox-input"
                  data-role="project-auto-dispatch-on-blocker-completion"
                  type="checkbox"
                  checked={autoDispatchOnBlockerCompletion}
                  onChange={(event) => setAutoDispatchOnBlockerCompletion(event.target.checked)}
                />
              </label>
              <p className="muted-copy">Last updated: {taskAutomationSettings?.updatedAt ? new Date(taskAutomationSettings.updatedAt).toLocaleString() : "—"}</p>
            </section>
          ) : null}

          {projectDetail ? (
            <section className="task-section">
              <div className="task-section__header">
                <div>
                  <p className="eyebrow">Repositories</p>
                  <h4>Project repositories</h4>
                </div>
              </div>

              <div className="task-section-list" data-role="project-repositories">
                {projectDetail.repositories.map((repository) => (
                  <article className="task-history-card" key={repository.id}>
                    <div className="workflow-section__header">
                      <strong>{repository.name}</strong>
                      <div className="action-cluster">
                        {projectDetail.defaultRepositoryId === repository.id ? <span className="status-badge status-badge--success">Default</span> : null}
                        {repository.sourceKind === "remote" ? <span className="status-badge status-badge--accent">Remote attached</span> : <span className="status-badge status-badge--neutral">Local only</span>}
                      </div>
                    </div>
                    <p className="muted-copy">{repository.repositoryPath ?? "No repository path"}</p>
                    <div className="workforce-meta-grid muted-copy">
                      <span>Mode: {repository.mode === "local_new" ? "New local repository" : "Existing repository"}</span>
                      <span>Source: {repository.sourcePath ?? "—"}</span>
                      <span>Kind: {repository.sourceKind ?? "—"}</span>
                      <span>Default branch: {repository.defaultBranch ?? "—"}</span>
                    </div>
                    <div className="action-cluster">
                      {projectDetail.defaultRepositoryId !== repository.id ? (
                        <button className="secondary-button" type="button" onClick={() => void handleSetDefaultRepository(repository.id)}>
                          Make default
                        </button>
                      ) : null}
                      <button
                        className="secondary-button"
                        data-role={`toggle-repository-remote-${repository.id}`}
                        type="button"
                        disabled={saving}
                        onClick={() => {
                          setAttachRemoteRepositoryId((current: string | null) => current === repository.id ? null : repository.id);
                          setRemoteDraft({ remoteUrl: repository.sourceKind === "remote" ? repository.sourcePath ?? "" : "", remoteName: "origin" });
                        }}
                      >
                        {repository.sourceKind === "remote" ? "Update remote" : "Add remote"}
                      </button>
                      <button
                        className="secondary-button secondary-button--danger"
                        data-role={`delete-repository-${repository.id}`}
                        type="button"
                        disabled={saving}
                        onClick={() => void handleDeleteRepository(repository.id, repository.name)}
                      >
                        Delete repository
                      </button>
                    </div>
                    {attachRemoteRepositoryId === repository.id ? (
                      <div className="task-editor-grid" data-role={`repository-remote-panel-${repository.id}`}>
                        <label className="field-group task-editor-grid__full">
                          <span className="field-group__label">Remote URL</span>
                          <input className="text-input" data-role="repository-remote-url" value={remoteDraft.remoteUrl ?? ""} onChange={(event) => setRemoteDraft((current) => ({ ...current, remoteUrl: event.target.value }))} />
                        </label>
                        <div className="task-editor-grid__full action-cluster">
                          <button className="secondary-button" data-role={`attach-repository-remote-${repository.id}`} type="button" disabled={saving || !remoteDraft.remoteUrl.trim()} onClick={() => void handleAttachRemote(repository.id)}>
                            {repository.sourceKind === "remote" ? "Update remote" : "Attach remote"}
                          </button>
                          <button className="secondary-button" type="button" disabled={saving} onClick={() => setAttachRemoteRepositoryId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>

              <div className="task-editor-grid">
                <div className="task-editor-grid__full">
                  <p className="eyebrow">Add repository</p>
                  <div className="filter-chip-row" role="tablist" aria-label="Repository creation mode">
                    <button
                      className={repositoryDraft.mode === "local_new" ? "filter-chip filter-chip--active" : "filter-chip"}
                      data-role="repository-mode-local-new"
                      type="button"
                      onClick={() => setRepositoryDraft((current) => ({ ...current, mode: "local_new", repositoryPath: "" }))}
                    >
                      New local repository
                    </button>
                    <button
                      className={repositoryDraft.mode !== "local_new" ? "filter-chip filter-chip--active" : "filter-chip"}
                      data-role="repository-mode-existing"
                      type="button"
                      onClick={() => setRepositoryDraft((current) => ({ ...current, mode: "existing" }))}
                    >
                      Existing repository
                    </button>
                  </div>
                </div>
                <label className="field-group">
                  <span className="field-group__label">Repository name</span>
                  <input className="text-input" data-role="repository-name" value={repositoryDraft.name ?? ""} onChange={(event) => setRepositoryDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                {repositoryDraft.mode === "local_new" ? (
                  <div className="field-group task-editor-grid__full muted-copy" data-role="repository-local-help">
                    Orchestra will create and manage a new git repository for this project. The managed repository directory becomes the main repository directory immediately.
                  </div>
                ) : (
                  <label className="field-group task-editor-grid__full">
                    <span className="field-group__label">Repository Path</span>
                    <input className="text-input" data-role="repository-path" value={repositoryDraft.repositoryPath ?? ""} onChange={(event) => setRepositoryDraft((current) => ({ ...current, repositoryPath: event.target.value }))} />
                  </label>
                )}
                <label className="field-group">
                  <span className="field-group__label">Default branch</span>
                  <input className="text-input" data-role="repository-default-branch" value={repositoryDraft.defaultBranch ?? ""} onChange={(event) => setRepositoryDraft((current) => ({ ...current, defaultBranch: event.target.value }))} />
                </label>
                <div className="task-editor-grid__full">
                  <button className="secondary-button" data-role="add-repository" type="button" disabled={saving} onClick={() => void handleAddRepository()}>
                    Add repository
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </div>
      </>
      )}
    />
  );
}
