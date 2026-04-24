import { useEffect, useState } from "react";

import type { ProjectSessionPromptSettings } from "../types";

interface PromptingPanelProps {
  activeProjectName?: string | null;
  sessionPromptSettings: ProjectSessionPromptSettings | null;
  onSaveSessionPromptTemplate: (template: string | null) => void;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function PromptingPanel({
  activeProjectName,
  sessionPromptSettings,
  onSaveSessionPromptTemplate,
}: PromptingPanelProps) {
  const [templateDraft, setTemplateDraft] = useState("");

  useEffect(() => {
    setTemplateDraft(sessionPromptSettings?.template ?? "");
  }, [sessionPromptSettings?.template]);

  return (
    <section className="panel prompting-panel">
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Prompting</p>
          <h3>Task session context prompt</h3>
          <p className="supporting-copy">Edit the task-session prompt for the active project{activeProjectName ? ` (${activeProjectName})` : ""}.</p>
        </div>
      </div>

      {sessionPromptSettings ? (
        <section className="task-section task-section--compact">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Template</p>
              <h4>Prompt template</h4>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" data-role="reset-session-prompt-template" type="button" onClick={() => setTemplateDraft(sessionPromptSettings.defaultTemplate)}>
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
          <p className="muted-copy">Last updated: {formatDateTime(sessionPromptSettings.updatedAt)}</p>
          <div className="bridge-diagnostics-table-wrap">
            <table className="task-table" data-role="session-prompt-token-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {sessionPromptSettings.availableTokens.map((token) => (
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
        <p className="supporting-copy">Select an active project to edit prompting settings.</p>
      )}
    </section>
  );
}
