import { useEffect, useMemo, useState } from "react";

import type { ProjectSessionPromptSettings, ProjectSummary } from "../types";

interface PromptingPanelProps {
  projects: ProjectSummary[];
  activeProjectId?: string | null;
  sessionPromptSettings: ProjectSessionPromptSettings | null;
  onSelectProject: (projectId: string) => void;
  onSaveSessionPromptTemplate: (template: string | null) => void;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function PromptingPanel({
  projects,
  activeProjectId,
  sessionPromptSettings,
  onSelectProject,
  onSaveSessionPromptTemplate,
}: PromptingPanelProps) {
  const [templateDraft, setTemplateDraft] = useState("");
  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const resolvedPromptSettings =
    activeProject?.slug === sessionPromptSettings?.projectSlug
      ? sessionPromptSettings
      : null;
  const hasProjects = projects.length > 0;

  useEffect(() => {
    setTemplateDraft(resolvedPromptSettings?.template ?? "");
  }, [resolvedPromptSettings?.template]);

  return (
    <section className="panel prompting-panel">
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Prompting</p>
          <h3>Task session context prompt</h3>
        </div>
      </div>

      <section className="task-section task-section--compact" data-role="prompting-project-scope">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Project scope</p>
            <h4>{activeProject?.name ?? (hasProjects ? "Select a project" : "No projects available")}</h4>
          </div>
        </div>
        <label className="field-group">
          <span className="field-group__label">Project</span>
          <select
            className="select-input"
            data-role="prompting-project-select"
            value={activeProjectId ?? ""}
            disabled={!hasProjects}
            onChange={(event) => {
              if (event.target.value) {
                onSelectProject(event.target.value);
              }
            }}
          >
            {!activeProjectId ? <option value="">Select a project</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <span className="field-group__hint">
            {!hasProjects
              ? "Create a project to edit prompting settings."
              : activeProject
                ? `Prompting settings are saved per project. Switch projects here to edit ${activeProject.name} or another project's task-session prompt.`
                : "Prompting settings are saved per project. Select a project here to load its task-session prompt."}
          </span>
        </label>
      </section>

      {resolvedPromptSettings ? (
        <section className="task-section task-section--compact">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Template</p>
              <h4>Prompt template</h4>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" data-role="reset-session-prompt-template" type="button" onClick={() => setTemplateDraft(resolvedPromptSettings.defaultTemplate)}>
                Reset draft to default
              </button>
              <button className="secondary-button" data-role="save-session-prompt-template" type="button" onClick={() => onSaveSessionPromptTemplate(templateDraft)}>
                Save template
              </button>
            </div>
          </div>
          <label className="field-group">
            <span className="field-group__label">Prompt template</span>
            <textarea
              className="text-area general-panel__prompt-template"
              data-role="session-prompt-template"
              rows={14}
              value={templateDraft}
              onChange={(event) => setTemplateDraft(event.target.value)}
            />
          </label>
          <p className="muted-copy">Last updated: {formatDateTime(resolvedPromptSettings.updatedAt)}</p>
          <div className="bridge-diagnostics-table-wrap">
            <table className="task-table" data-role="session-prompt-token-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {resolvedPromptSettings.availableTokens.map((token) => (
                  <tr key={token.token} data-role="session-prompt-token-row">
                    <td><code>{token.token}</code></td>
                    <td>{token.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p className="supporting-copy" data-role="prompting-project-status">
          {activeProject
            ? `Loading prompting settings for ${activeProject.name}.`
            : hasProjects
              ? "Select a project to edit prompting settings."
              : "Create a project to edit prompting settings."}
        </p>
      )}
    </section>
  );
}
