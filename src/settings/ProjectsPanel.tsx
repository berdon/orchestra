import { useEffect, useMemo, useState } from "react";

import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SettingsMobileSubnavHeader } from "../components/SettingsMobileSubnavHeader";
import { SettingsSectionTabs } from "../components/SettingsSectionTabs";
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
} from "../lib/projects";
import {
  createProjectSecret,
  deleteProjectSecret,
  getProjectSecrets,
  getTaskAutomationSettings,
  updateProjectSecret,
  updateTaskAutomationSettings,
} from "../lib/projectSettings";
import {
  buildSourceControlPreviewRows,
  getProjectSourceControlSettings,
  getSourceControlTemplateErrors,
  getSourceControlSettings,
  updateProjectSourceControlSettings,
} from "../lib/sourceControlSettings";
import { normalizeTaskPrefix, suggestTaskPrefix, validateTaskPrefix } from "../lib/taskPrefixes";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import { SourceControlPreviewTable } from "./SourceControlPreviewTable";
import type {
  ProjectDetail,
  ProjectSecretMetadata,
  ProjectSecretsState,
  ProjectSourceControlSettings,
  ProjectSummary,
  ProjectTaskAutomationSettings,
  ProjectUpsertInput,
  RepositoryRemoteInput,
  RepositoryUpsertInput,
  SourceControlSettings,
} from "../types";

function createBlankProjectDraft(): ProjectUpsertInput {
  return { name: "", description: "", taskPrefix: "" };
}

function createBlankRepositoryDraft(): RepositoryUpsertInput {
  return { name: "", mode: "existing", repositoryPath: "", defaultBranch: "main" };
}

function createBlankRemoteDraft(): RepositoryRemoteInput {
  return { remoteUrl: "", remoteName: "origin" };
}

function createBlankSecretDraft() {
  return { secretKey: "", description: "", value: "" };
}

type ProjectDetailTabId = "general" | "repositories" | "automation" | "source-control" | "secrets";

const PROJECT_SECRET_RESERVED_KEYS = new Set(["PATH", "HOME", "SHELL", "TERM"]);
const PROJECT_SECRET_RESERVED_PREFIXES = ["ORCHESTRA_", "PI_", "NPM_", "NPM_CONFIG_", "NPM_PACKAGE_", "NPM_LIFECYCLE_"];

function validateSecretKey(secretKey: string) {
  const normalized = secretKey.trim().toUpperCase();
  if (!normalized) {
    return "Secret key is required.";
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    return "Secret keys must start with a letter and use only A-Z, 0-9, and _.";
  }
  if (PROJECT_SECRET_RESERVED_KEYS.has(normalized) || PROJECT_SECRET_RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return `Secret key ${normalized} uses a reserved name or prefix.`;
  }
  return null;
}

function formatSecretStatus(secret: ProjectSecretMetadata) {
  switch (secret.valueState) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "missing_value":
      return { label: "Missing value", tone: "warning" };
    case "store_locked":
      return { label: "Store locked", tone: "warning" };
    case "store_error":
      return { label: "Store error", tone: "danger" };
    default:
      return { label: secret.valueState, tone: "neutral" };
  }
}

export function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const getTooltipProps = useExplanatoryTooltipProps();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectUpsertInput>(createBlankProjectDraft);
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryUpsertInput>(createBlankRepositoryDraft);
  const [attachRemoteRepositoryId, setAttachRemoteRepositoryId] = useState<string | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<RepositoryRemoteInput>(createBlankRemoteDraft);
  const [taskAutomationSettings, setTaskAutomationSettings] = useState<ProjectTaskAutomationSettings | null>(null);
  const [sourceControlSettings, setSourceControlSettings] = useState<SourceControlSettings | null>(null);
  const [projectSourceControlSettings, setProjectSourceControlSettings] = useState<ProjectSourceControlSettings | null>(null);
  const [projectSecretsState, setProjectSecretsState] = useState<ProjectSecretsState | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<ProjectDetailTabId>("general");
  const [secretDraft, setSecretDraft] = useState(createBlankSecretDraft);
  const [editingSecretKey, setEditingSecretKey] = useState<string | null>(null);
  const [autoDispatchOnBlockerCompletion, setAutoDispatchOnBlockerCompletion] = useState(false);
  const [gitUserNameTemplate, setGitUserNameTemplate] = useState("");
  const [gitEmailTemplate, setGitEmailTemplate] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectTaskPrefixEdited, setProjectTaskPrefixEdited] = useState(false);
  const [deleteProjectConfirmationArmed, setDeleteProjectConfirmationArmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingAutomation, setLoadingAutomation] = useState(false);
  const [loadingSourceControl, setLoadingSourceControl] = useState(false);
  const [loadingSecrets, setLoadingSecrets] = useState(false);
  const [automationLoadedProjectSlug, setAutomationLoadedProjectSlug] = useState<string | null>(null);
  const [sourceControlLoadedProjectSlug, setSourceControlLoadedProjectSlug] = useState<string | null>(null);
  const [secretsLoadedProjectSlug, setSecretsLoadedProjectSlug] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => (isCreatingProject ? null : projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null),
    [isCreatingProject, projects, selectedProjectId],
  );
  const projectTaskPrefixError = useMemo(() => {
    const formatError = validateTaskPrefix(projectDraft.taskPrefix);
    if (formatError) {
      return formatError;
    }

    const normalizedTaskPrefix = normalizeTaskPrefix(projectDraft.taskPrefix);
    const duplicate = projects.some((project) => project.id !== selectedProject?.id && normalizeTaskPrefix(project.taskPrefix) === normalizedTaskPrefix);
    if (duplicate) {
      return `Task prefix ${normalizedTaskPrefix} is already used by another project.`;
    }

    return null;
  }, [projectDraft.taskPrefix, projects, selectedProject?.id]);
  const sourceControlTemplateErrors = useMemo(
    () => getSourceControlTemplateErrors({ gitUserNameTemplate, gitEmailTemplate }),
    [gitEmailTemplate, gitUserNameTemplate],
  );
  const sourceControlPreviewRows = useMemo(
    () => buildSourceControlPreviewRows(
      {
        gitUserNameTemplate: sourceControlSettings?.gitUserNameTemplate ?? null,
        gitEmailTemplate: sourceControlSettings?.gitEmailTemplate ?? null,
      },
      {
        gitUserNameTemplate,
        gitEmailTemplate,
      },
    ),
    [gitEmailTemplate, gitUserNameTemplate, sourceControlSettings?.gitEmailTemplate, sourceControlSettings?.gitUserNameTemplate],
  );
  const saveProjectDisabled = saving || !projectDraft.name.trim() || Boolean(projectTaskPrefixError);
  const secretKeyError = useMemo(() => validateSecretKey(secretDraft.secretKey), [secretDraft.secretKey]);
  const saveSecretDisabled = saving
    || !selectedProject?.slug
    || !secretDraft.secretKey.trim()
    || Boolean(secretKeyError)
    || (!editingSecretKey && !secretDraft.value.trim());
  const projectDetailTabs = useMemo(() => {
    const tabs: Array<{ id: ProjectDetailTabId; label: string }> = [{ id: "general", label: "General" }];
    if (!isCreatingProject) {
      tabs.push(
        { id: "repositories", label: "Repositories" },
        { id: "automation", label: "Automation" },
        { id: "source-control", label: "Source Control" },
        { id: "secrets", label: "Secrets" },
      );
    }
    return tabs;
  }, [isCreatingProject]);

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
      setProjectDraft({ name: detail.name, description: detail.description ?? "", taskPrefix: detail.taskPrefix });
      setTaskAutomationSettings(null);
      setSourceControlSettings(null);
      setProjectSourceControlSettings(null);
      setProjectSecretsState(null);
      setAutomationLoadedProjectSlug(null);
      setSourceControlLoadedProjectSlug(null);
      setSecretsLoadedProjectSlug(null);
      setSecretDraft(createBlankSecretDraft());
      setEditingSecretKey(null);
      setProjectTaskPrefixEdited(false);
      setAutoDispatchOnBlockerCompletion(false);
      setGitUserNameTemplate("");
      setGitEmailTemplate("");
      setIsCreatingProject(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load project detail.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAutomationSettings(projectSlug: string) {
    setLoadingAutomation(true);
    setError(null);
    try {
      const automationSettings = await getTaskAutomationSettings(projectSlug);
      setTaskAutomationSettings(automationSettings);
      setAutoDispatchOnBlockerCompletion(automationSettings.autoDispatchOnBlockerCompletion);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load task automation settings.");
    } finally {
      setAutomationLoadedProjectSlug(projectSlug);
      setLoadingAutomation(false);
    }
  }

  async function loadSourceControlTabSettings(projectSlug: string) {
    setLoadingSourceControl(true);
    setError(null);
    try {
      const [globalSourceControlSettings, nextProjectSourceControlSettings] = await Promise.all([
        getSourceControlSettings(),
        getProjectSourceControlSettings(projectSlug),
      ]);
      setSourceControlSettings(globalSourceControlSettings);
      setProjectSourceControlSettings(nextProjectSourceControlSettings);
      setGitUserNameTemplate(nextProjectSourceControlSettings.gitUserNameTemplate ?? "");
      setGitEmailTemplate(nextProjectSourceControlSettings.gitEmailTemplate ?? "");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load project source control settings.");
    } finally {
      setSourceControlLoadedProjectSlug(projectSlug);
      setLoadingSourceControl(false);
    }
  }

  async function loadSecrets(projectSlug: string) {
    setLoadingSecrets(true);
    setError(null);
    try {
      setProjectSecretsState(await getProjectSecrets(projectSlug));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load project secrets.");
    } finally {
      setSecretsLoadedProjectSlug(projectSlug);
      setLoadingSecrets(false);
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

  useEffect(() => {
    if (!projectDetailTabs.some((tab) => tab.id === activeDetailTab)) {
      setActiveDetailTab("general");
    }
  }, [activeDetailTab, projectDetailTabs]);

  useEffect(() => {
    if (!projectDetail?.slug || typeof window === "undefined") {
      return;
    }

    const projectSlug = projectDetail.slug;
    const timeoutId = window.setTimeout(() => {
      if (!loadingAutomation && automationLoadedProjectSlug !== projectSlug) {
        void loadAutomationSettings(projectSlug);
      }
      if (!loadingSourceControl && sourceControlLoadedProjectSlug !== projectSlug) {
        void loadSourceControlTabSettings(projectSlug);
      }
      if (!loadingSecrets && secretsLoadedProjectSlug !== projectSlug) {
        void loadSecrets(projectSlug);
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [
    automationLoadedProjectSlug,
    loadingAutomation,
    loadingSecrets,
    loadingSourceControl,
    projectDetail?.slug,
    secretsLoadedProjectSlug,
    sourceControlLoadedProjectSlug,
  ]);

  function handleProjectNameChange(value: string) {
    setProjectDraft((current) => ({
      ...current,
      name: value,
      taskPrefix: isCreatingProject && !projectTaskPrefixEdited
        ? (value.trim() ? suggestTaskPrefix(value, projects.map((project) => project.taskPrefix)) : "")
        : current.taskPrefix,
    }));
  }

  function resetSecretEditor() {
    setSecretDraft(createBlankSecretDraft());
    setEditingSecretKey(null);
  }

  function handleDetailTabSelect(tabId: ProjectDetailTabId) {
    setActiveDetailTab(tabId);
    const projectSlug = projectDetail?.slug;
    if (!projectSlug) {
      return;
    }
    if (tabId === "automation" && !loadingAutomation && automationLoadedProjectSlug !== projectSlug) {
      void loadAutomationSettings(projectSlug);
      return;
    }
    if (tabId === "source-control" && !loadingSourceControl && sourceControlLoadedProjectSlug !== projectSlug) {
      void loadSourceControlTabSettings(projectSlug);
      return;
    }
    if (tabId === "secrets" && !loadingSecrets && secretsLoadedProjectSlug !== projectSlug) {
      void loadSecrets(projectSlug);
    }
  }

  async function handleSaveProject() {
    if (saveProjectDisabled) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const creatingNewProject = !selectedProject?.id || isCreatingProject;
      const saved = selectedProject?.id && !isCreatingProject
        ? await updateProject(selectedProject.id, projectDraft)
        : await createProject(projectDraft);
      await loadProjects();
      setSelectedProjectId(saved.id);
      setIsCreatingProject(false);
      if (creatingNewProject) {
        setActiveDetailTab("repositories");
      }
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
      const updated = await updateTaskAutomationSettings(autoDispatchOnBlockerCompletion, selectedProject.slug);
      setTaskAutomationSettings(updated);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to update automation settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveProjectSourceControlSettings() {
    if (!selectedProject) {
      return;
    }
    if (sourceControlTemplateErrors.gitUserNameTemplate.length || sourceControlTemplateErrors.gitEmailTemplate.length) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await updateProjectSourceControlSettings(gitUserNameTemplate, gitEmailTemplate, selectedProject.slug);
      setProjectSourceControlSettings(updated);
      setGitUserNameTemplate(updated.gitUserNameTemplate ?? "");
      setGitEmailTemplate(updated.gitEmailTemplate ?? "");
      setSourceControlSettings(await getSourceControlSettings());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to update project source control settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSecret() {
    if (!selectedProject?.slug || saveSecretDisabled) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const input = {
        secretKey: secretDraft.secretKey.trim().toUpperCase(),
        description: secretDraft.description.trim() || null,
        value: secretDraft.value || null,
      };
      const nextState = editingSecretKey
        ? await updateProjectSecret(input, selectedProject.slug)
        : await createProjectSecret(input, selectedProject.slug);
      setProjectSecretsState(nextState);
      resetSecretEditor();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to save project secret.");
    } finally {
      setSaving(false);
    }
  }

  function handleEditSecret(secret: ProjectSecretMetadata) {
    setEditingSecretKey(secret.secretKey);
    setSecretDraft({
      secretKey: secret.secretKey,
      description: secret.description ?? "",
      value: "",
    });
  }

  async function handleDeleteSecret(secret: ProjectSecretMetadata) {
    if (!selectedProject?.slug) {
      return;
    }

    const confirmed = window.confirm(`Delete project secret ${secret.secretKey}? This removes both the metadata and the secure-store value.`);
    if (!confirmed) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const nextState = await deleteProjectSecret(secret.secretKey, selectedProject.slug);
      setProjectSecretsState(nextState);
      if (editingSecretKey === secret.secretKey) {
        resetSecretEditor();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to delete project secret.");
    } finally {
      setSaving(false);
    }
  }

  function beginCreateProject() {
    setSelectedProjectId(null);
    setProjectDetail(null);
    setProjectSecretsState(null);
    setProjectDraft(createBlankProjectDraft());
    setRepositoryDraft(createBlankRepositoryDraft());
    setAttachRemoteRepositoryId(null);
    setRemoteDraft(createBlankRemoteDraft());
    setTaskAutomationSettings(null);
    setSourceControlSettings(null);
    setProjectSourceControlSettings(null);
    setAutomationLoadedProjectSlug(null);
    setSourceControlLoadedProjectSlug(null);
    setSecretsLoadedProjectSlug(null);
    setGitUserNameTemplate("");
    setGitEmailTemplate("");
    setAutoDispatchOnBlockerCompletion(false);
    setProjectTaskPrefixEdited(false);
    setActiveDetailTab("general");
    resetSecretEditor();
    setDeleteProjectConfirmationArmed(false);
    setIsCreatingProject(true);
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
      setTaskAutomationSettings(null);
      setSourceControlSettings(null);
      setProjectSourceControlSettings(null);
      setProjectSecretsState(null);
      setAutomationLoadedProjectSlug(null);
      setSourceControlLoadedProjectSlug(null);
      setSecretsLoadedProjectSlug(null);
      setSelectedProjectId(null);
      setIsCreatingProject(false);
      setDeleteProjectConfirmationArmed(false);
      setActiveDetailTab("general");
      await loadProjects();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to delete project.");
    } finally {
      setSaving(false);
    }
  }

  function renderTabPanel(tabId: ProjectDetailTabId) {
    switch (tabId) {
      case "general":
        return (
          <section className="task-section" data-role="project-detail-tabpanel-general">
            <div className="task-editor-grid">
              <label className="field-group">
                <span className="field-group__label">Name</span>
                <input className="text-input" data-role="project-name" value={projectDraft.name} onChange={(event) => handleProjectNameChange(event.target.value)} />
              </label>
              <label className="field-group" {...getTooltipProps("Choose the prefix used for new task numbers in this project.")}>
                <span className="field-group__label">Task prefix</span>
                <input
                  className="text-input"
                  data-role="project-task-prefix"
                  value={projectDraft.taskPrefix}
                  onChange={(event) => {
                    setProjectTaskPrefixEdited(true);
                    setProjectDraft((current) => ({ ...current, taskPrefix: event.target.value }));
                  }}
                />
                <span className="supporting-copy">Used for new task numbers such as {normalizeTaskPrefix(projectDraft.taskPrefix) || "APP"}-42. Existing task numbers stay the same.</span>
                {projectTaskPrefixError ? <span className="error-copy">{projectTaskPrefixError}</span> : null}
              </label>
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Description</span>
                <textarea className="text-area" data-role="project-description" rows={4} value={projectDraft.description ?? ""} onChange={(event) => setProjectDraft((current) => ({ ...current, description: event.target.value }))} />
              </label>
            </div>
          </section>
        );
      case "automation":
        return projectDetail ? (
          <section className="task-section task-section--compact" data-role="project-detail-tabpanel-automation">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Automation</p>
                <h4>Task dispatch</h4>
                <p className="supporting-copy">Dispatch tasks automatically when creation or unblocking makes them ready for work.</p>
              </div>
              <button
                className="secondary-button"
                data-role="save-project-automation-settings"
                type="button"
                disabled={saving || !selectedProject || !taskAutomationSettings}
                onClick={() => void handleSaveTaskAutomationSettings()}
              >
                Save automation settings
              </button>
            </div>
            {loadingAutomation && !taskAutomationSettings ? <p className="muted-copy">Loading automation settings…</p> : null}
            {taskAutomationSettings ? (
              <>
                <label className="field-group task-editor-grid__full" data-role="project-automation-settings" {...getTooltipProps("Automatically dispatch tasks when creation, unblocking, or dependency changes make them ready for work.")}>
                  <span className="field-group__label">Enable auto task dispatching for newly work-ready tasks</span>
                  <input
                    className="checkbox-input"
                    data-role="project-auto-dispatch-on-blocker-completion"
                    type="checkbox"
                    checked={autoDispatchOnBlockerCompletion}
                    onChange={(event) => setAutoDispatchOnBlockerCompletion(event.target.checked)}
                  />
                </label>
                <p className="muted-copy">Last updated: {taskAutomationSettings.updatedAt ? new Date(taskAutomationSettings.updatedAt).toLocaleString() : "—"}</p>
              </>
            ) : null}
          </section>
        ) : null;
      case "source-control":
        return projectDetail ? (
          <section className="task-section task-section--compact" data-role="project-detail-tabpanel-source-control">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Source control</p>
                <h4>Project git identity overrides</h4>
                <p className="supporting-copy">Leave a field blank to inherit the global default from Settings → Source Control.</p>
              </div>
              <button
                className="secondary-button"
                data-role="save-project-source-control-settings"
                type="button"
                disabled={saving || !sourceControlSettings || !projectSourceControlSettings || Boolean(sourceControlTemplateErrors.gitUserNameTemplate.length) || Boolean(sourceControlTemplateErrors.gitEmailTemplate.length) || !selectedProject}
                onClick={() => void handleSaveProjectSourceControlSettings()}
              >
                Save source control overrides
              </button>
            </div>
            {loadingSourceControl && (!sourceControlSettings || !projectSourceControlSettings) ? <p className="muted-copy">Loading source control settings…</p> : null}
            {sourceControlSettings && projectSourceControlSettings ? (
              <>
                <div className="task-editor-grid" data-role="project-source-control-settings">
                  <label className="field-group">
                    <span className="field-group__label">Git user.name override</span>
                    <input className="text-input" data-role="project-git-user-name-template" value={gitUserNameTemplate} onChange={(event) => setGitUserNameTemplate(event.target.value)} />
                    {sourceControlTemplateErrors.gitUserNameTemplate.length ? <span className="error-copy">Unknown variables: {sourceControlTemplateErrors.gitUserNameTemplate.join(", ")}</span> : null}
                  </label>
                  <label className="field-group">
                    <span className="field-group__label">Git user.email override</span>
                    <input className="text-input" data-role="project-git-email-template" value={gitEmailTemplate} onChange={(event) => setGitEmailTemplate(event.target.value)} />
                    {sourceControlTemplateErrors.gitEmailTemplate.length ? <span className="error-copy">Unknown variables: {sourceControlTemplateErrors.gitEmailTemplate.join(", ")}</span> : null}
                  </label>
                </div>
                <SourceControlPreviewTable rows={sourceControlPreviewRows} dataRole="project-source-control-preview-table" />
                <p className="muted-copy">Last updated: {projectSourceControlSettings.updatedAt ? new Date(projectSourceControlSettings.updatedAt).toLocaleString() : "—"}</p>
              </>
            ) : null}
          </section>
        ) : null;
      case "repositories":
        return projectDetail ? (
          <section className="task-section" data-role="project-detail-tabpanel-repositories">
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
                <span className="field-group__hint">Merge/mainline branch used for task worktrees. Orchestra keeps the managed checkout on a separate workspace branch.</span>
              </label>
              <div className="task-editor-grid__full">
                <button className="secondary-button" data-role="add-repository" type="button" disabled={saving} onClick={() => void handleAddRepository()}>
                  Add repository
                </button>
              </div>
            </div>
          </section>
        ) : null;
      case "secrets":
        return (
          <section className="task-section" data-role="project-detail-tabpanel-secrets">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Secrets</p>
                <h4>Project-scoped secrets</h4>
                <p className="supporting-copy">Define secure project-level secrets once, then let authorized agent sessions load them into environment variables for safe tool use.</p>
              </div>
              {projectDetail?.slug ? (
                <button className="secondary-button" type="button" disabled={saving || loadingSecrets} onClick={() => void loadSecrets(projectDetail.slug)}>
                  Refresh secrets
                </button>
              ) : null}
            </div>

            {!projectDetail ? (
              <p className="muted-copy">Create the project before adding project-scoped secrets.</p>
            ) : null}
            {loadingSecrets ? <p className="muted-copy">Loading project secrets…</p> : null}
            {projectSecretsState ? (
              <>
                <div className="task-history-card" data-role="project-secrets-status">
                  <div className="workflow-section__header">
                    <strong>Secure-store status</strong>
                    <span className={`status-badge status-badge--${projectSecretsState.availability.status === "available" ? "success" : projectSecretsState.availability.status === "locked" ? "warning" : "danger"}`}>
                      {projectSecretsState.availability.status === "available"
                        ? "Available"
                        : projectSecretsState.availability.status === "locked"
                          ? "Locked"
                          : projectSecretsState.availability.status === "unsupported"
                            ? "Unsupported"
                            : "Error"}
                    </span>
                  </div>
                  <p className="muted-copy">Values are stored in the host secure store rather than ordinary Orchestra app data. Secret values are never shown again after save.</p>
                  {projectSecretsState.availability.message ? <p className="muted-copy">{projectSecretsState.availability.message}</p> : null}
                </div>

                <div className="task-editor-grid" data-role="project-secret-editor">
                  <div className="task-editor-grid__full task-history-card">
                    <div className="workflow-section__header">
                      <strong>{editingSecretKey ? `Edit ${editingSecretKey}` : "Add project secret"}</strong>
                      {editingSecretKey ? (
                        <button className="secondary-button" type="button" disabled={saving} onClick={resetSecretEditor}>Cancel edit</button>
                      ) : null}
                    </div>
                    <div className="task-editor-grid">
                      <label className="field-group">
                        <span className="field-group__label">Secret key</span>
                        <input
                          className="text-input"
                          data-role="project-secret-key"
                          value={secretDraft.secretKey}
                          disabled={Boolean(editingSecretKey)}
                          onChange={(event) => setSecretDraft((current) => ({ ...current, secretKey: event.target.value.toUpperCase() }))}
                        />
                        <span className="supporting-copy">Use env-var shaped names like OPENAI_API_KEY.</span>
                        {secretKeyError ? <span className="error-copy">{secretKeyError}</span> : null}
                      </label>
                      <label className="field-group task-editor-grid__full">
                        <span className="field-group__label">Description</span>
                        <input
                          className="text-input"
                          data-role="project-secret-description"
                          value={secretDraft.description}
                          onChange={(event) => setSecretDraft((current) => ({ ...current, description: event.target.value }))}
                        />
                      </label>
                      <label className="field-group task-editor-grid__full">
                        <span className="field-group__label">Secret value</span>
                        <textarea
                          className="text-area"
                          data-role="project-secret-value"
                          rows={3}
                          value={secretDraft.value}
                          onChange={(event) => setSecretDraft((current) => ({ ...current, value: event.target.value }))}
                        />
                        <span className="supporting-copy">{editingSecretKey ? "Leave blank to keep the current stored value. Enter a new value to rotate it." : "The value is stored securely and will not be shown again after save."}</span>
                      </label>
                      <div className="task-editor-grid__full action-cluster">
                        <button className="secondary-button" data-role="save-project-secret" type="button" disabled={saveSecretDisabled || projectSecretsState.availability.status !== "available"} onClick={() => void handleSaveSecret()}>
                          {editingSecretKey ? "Save secret" : "Create secret"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="task-section-list" data-role="project-secrets-list">
                  {projectSecretsState.secrets.length ? projectSecretsState.secrets.map((secret) => {
                    const status = formatSecretStatus(secret);
                    return (
                      <article className="task-history-card" key={secret.id}>
                        <div className="workflow-section__header">
                          <strong>{secret.secretKey}</strong>
                          <span className={`status-badge status-badge--${status.tone}`}>{status.label}</span>
                        </div>
                        <p className="muted-copy">{secret.description || "No description"}</p>
                        <div className="workforce-meta-grid muted-copy">
                          <span>Last rotated: {new Date(secret.lastRotatedAt).toLocaleString()}</span>
                          <span>Updated: {new Date(secret.updatedAt).toLocaleString()}</span>
                        </div>
                        {secret.valueStateMessage ? <p className="muted-copy">{secret.valueStateMessage}</p> : null}
                        <div className="action-cluster">
                          <button className="secondary-button" type="button" disabled={saving} onClick={() => handleEditSecret(secret)}>
                            Edit / rotate
                          </button>
                          <button className="secondary-button secondary-button--danger" type="button" disabled={saving} onClick={() => void handleDeleteSecret(secret)}>
                            Delete secret
                          </button>
                        </div>
                      </article>
                    );
                  }) : (
                    <p className="muted-copy">No project secrets yet.</p>
                  )}
                </div>
              </>
            ) : null}
          </section>
        );
      default:
        return null;
    }
  }

  const projectMobileActions = [
    {
      id: "new-project",
      label: "New project",
      onClick: beginCreateProject,
      variant: "secondary" as const,
    },
    ...(selectedProject
      ? [{
          id: "delete-project",
          label: deleteProjectConfirmationArmed ? "Confirm delete project" : "Delete project",
          onClick: () => void handleDeleteProject(),
          disabled: saving,
          variant: deleteProjectConfirmationArmed ? "danger" as const : "secondary" as const,
        }]
      : []),
    ...(selectedProject && deleteProjectConfirmationArmed
      ? [{
          id: "cancel-delete-project",
          label: "Cancel delete",
          onClick: () => setDeleteProjectConfirmationArmed(false),
          disabled: saving,
          variant: "secondary" as const,
        }]
      : []),
    {
      id: "save-project",
      label: saving ? (selectedProject ? "Saving…" : "Creating…") : selectedProject ? "Save project" : "Create project",
      onClick: () => void handleSaveProject(),
      disabled: saveProjectDisabled,
      variant: "primary" as const,
    },
  ];

  return (
    <>
      <SettingsMobileSubnavHeader
        dataRolePrefix="project"
        selectLabel="Project"
        ariaLabel="Project selection"
        value={isCreatingProject ? null : selectedProject?.id ?? null}
        emptyOptionLabel={isCreatingProject ? "New project" : "Select project"}
        options={projects.map((project) => ({ id: project.id, label: project.name }))}
        onChange={(projectId) => {
          if (projectId) {
            setSelectedProjectId(projectId);
            setIsCreatingProject(false);
          }
        }}
        actions={projectMobileActions}
        actionMenuLabel="Project actions"
      />
      <ResizableSidebarLayout
      className="task-shell"
      storageKey="orchestra.layout.projects.secondary-nav-width"
      navigationClassName="task-nav-panel settings-mobile-subnav-panel"
      detailClassName="panel task-detail-panel"
      navigation={(
        <>
          <div className="panel__header panel__header--stacked">
            <div>
              <p className="eyebrow">Project catalog</p>
              <h3>Projects</h3>
            </div>
            <button className="primary-button settings-mobile-subnav-redundant-actions" type="button" onClick={beginCreateProject}>
              New project
            </button>
          </div>

          {loading ? <p className="muted-copy">Loading projects…</p> : null}
          {error ? <p className="error-copy">{error}</p> : null}

          <nav className="task-list settings-mobile-subnav-list" aria-label="Projects">
            {projects.map((project) => (
              <a
                key={project.id}
                className={project.id === selectedProject?.id ? "task-list-link task-list-link--active" : "task-list-link"}
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  setSelectedProjectId(project.id);
                  setIsCreatingProject(false);
                }}
              >
                <span className="task-list-link__eyebrow">{project.slug} · {project.taskPrefix}</span>
                <strong>{project.name}</strong>
              </a>
            ))}
          </nav>
        </>
      )}
      detail={(
        <SettingsSectionTabs
          className="task-detail-stack"
          ariaLabel="Project settings sections"
          dataRolePrefix="project-detail"
          initialTabId="general"
          activeTabId={activeDetailTab}
          onTabChange={(tabId) => handleDetailTabSelect(tabId as ProjectDetailTabId)}
          header={(
            <div className="panel__header panel__header--session-detail">
              <div>
                <p className="eyebrow">Project detail</p>
                <h3>{selectedProject ? selectedProject.name : "New project"}</h3>
                <p className="muted-copy">Task prefix: {selectedProject?.taskPrefix ?? (normalizeTaskPrefix(projectDraft.taskPrefix) || "—")}</p>
              </div>
              <div className="row-actions settings-mobile-subnav-redundant-actions">
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
                <button className="primary-button" type="button" disabled={saveProjectDisabled} onClick={() => void handleSaveProject()}>
                  {saving ? "Saving…" : selectedProject ? "Save project" : "Create project"}
                </button>
              </div>
            </div>
          )}
          tabs={projectDetailTabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            panel: renderTabPanel(tab.id),
          }))}
        />
      )}
    />
    </>
  );
}
