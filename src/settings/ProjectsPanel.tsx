import { useEffect, useMemo, useState } from "react";

import {
  createProject,
  createRepository,
  deleteProject,
  getProject,
  listProjects,
  setProjectDefaultRepository,
  updateProject,
  updateRepository,
} from "../lib/projects";
import type { ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryUpsertInput } from "../types";

function createBlankProjectDraft(): ProjectUpsertInput {
  return { name: "", description: "" };
}

function createBlankRepositoryDraft(): RepositoryUpsertInput {
  return { name: "", repositoryPath: "", defaultBranch: "main" };
}

export function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectUpsertInput>(createBlankProjectDraft);
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryUpsertInput>(createBlankRepositoryDraft);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
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
      setProjectDetail(detail);
      setProjectDraft({ name: detail.name, description: detail.description ?? "" });
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

  async function handleDeleteProject() {
    if (!selectedProject?.id || selectedProject.id === "orchestra") {
      return;
    }

    const confirmed = window.confirm(`Delete project "${selectedProject.name}"? This removes its Orchestra-managed project data.`);
    if (!confirmed) {
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
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to delete project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="task-shell">
      <aside className="task-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Project catalog</p>
            <h3>Projects</h3>
          </div>
          <button className="primary-button" type="button" onClick={() => {
            setSelectedProjectId(null);
            setProjectDetail(null);
            setProjectDraft(createBlankProjectDraft());
            setRepositoryDraft(createBlankRepositoryDraft());
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
      </aside>

      <section className="panel task-detail-panel">
        <div className="task-detail-stack">
          <div className="panel__header panel__header--session-detail">
            <div>
              <p className="eyebrow">Project detail</p>
              <h3>{selectedProject ? selectedProject.name : "New project"}</h3>
            </div>
            <div className="row-actions">
              {selectedProject && selectedProject.id !== "orchestra" ? (
                <button className="secondary-button" data-role="delete-project" type="button" disabled={saving} onClick={() => void handleDeleteProject()}>
                  Delete project
                </button>
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
                      {projectDetail.defaultRepositoryId === repository.id ? <span className="status-badge status-badge--success">Default</span> : null}
                    </div>
                    <p className="muted-copy">{repository.repositoryPath ?? "No repository path"}</p>
                    <div className="workforce-meta-grid muted-copy">
                      <span>Source: {repository.sourcePath ?? "—"}</span>
                      <span>Kind: {repository.sourceKind ?? "—"}</span>
                      <span>Default branch: {repository.defaultBranch ?? "—"}</span>
                    </div>
                    {projectDetail.defaultRepositoryId !== repository.id ? (
                      <button className="secondary-button" type="button" onClick={() => void handleSetDefaultRepository(repository.id)}>
                        Make default
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>

              <div className="task-editor-grid">
                <label className="field-group">
                  <span className="field-group__label">Repository name</span>
                  <input className="text-input" data-role="repository-name" value={repositoryDraft.name ?? ""} onChange={(event) => setRepositoryDraft((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="field-group task-editor-grid__full">
                  <span className="field-group__label">Repository Path</span>
                  <input className="text-input" data-role="repository-path" value={repositoryDraft.repositoryPath ?? ""} onChange={(event) => setRepositoryDraft((current) => ({ ...current, repositoryPath: event.target.value }))} />
                </label>
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
      </section>
    </section>
  );
}
