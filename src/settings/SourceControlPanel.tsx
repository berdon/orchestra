import { useEffect, useMemo, useState } from "react";

import {
  buildSourceControlPreviewRows,
  getSourceControlTemplateErrors,
  getSourceControlSettings,
  updateSourceControlSettings,
} from "../lib/sourceControlSettings";
import { SourceControlPreviewTable } from "./SourceControlPreviewTable";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function SourceControlPanel() {
  const [gitUserNameTemplate, setGitUserNameTemplate] = useState("");
  const [gitEmailTemplate, setGitEmailTemplate] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const settings = await getSourceControlSettings();
      setGitUserNameTemplate(settings.gitUserNameTemplate ?? "");
      setGitEmailTemplate(settings.gitEmailTemplate ?? "");
      setUpdatedAt(settings.updatedAt ?? null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load source control settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const templateErrors = useMemo(
    () => getSourceControlTemplateErrors({ gitUserNameTemplate, gitEmailTemplate }),
    [gitEmailTemplate, gitUserNameTemplate],
  );
  const previewRows = useMemo(
    () => buildSourceControlPreviewRows({ gitUserNameTemplate, gitEmailTemplate }),
    [gitEmailTemplate, gitUserNameTemplate],
  );
  const saveDisabled = loading || saving || templateErrors.gitUserNameTemplate.length > 0 || templateErrors.gitEmailTemplate.length > 0;

  async function handleSave() {
    if (saveDisabled) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await updateSourceControlSettings(gitUserNameTemplate, gitEmailTemplate);
      setGitUserNameTemplate(saved.gitUserNameTemplate ?? "");
      setGitEmailTemplate(saved.gitEmailTemplate ?? "");
      setUpdatedAt(saved.updatedAt ?? null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to save source control settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel source-control-panel">
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Source Control</p>
          <h3>Global git identity defaults</h3>
        </div>
        <div className="action-cluster action-cluster--wrap">
          <button className="secondary-button" data-role="save-source-control-settings" type="button" disabled={saveDisabled} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save source control settings"}
          </button>
        </div>
      </div>

      {loading ? <p className="muted-copy">Loading source control settings…</p> : null}
      {error ? <p className="error-copy">{error}</p> : null}

      <div className="task-editor-grid">
        <label className="field-group">
          <span className="field-group__label">Default git user.name template</span>
          <input className="text-input" data-role="source-control-git-user-name-template" value={gitUserNameTemplate} disabled={loading || saving} onChange={(event) => setGitUserNameTemplate(event.target.value)} />
          <span className="field-group__hint">Examples: <code>Orchestra {"{role}"}</code> or <code>Client reviewer</code>.</span>
          {templateErrors.gitUserNameTemplate.length ? <span className="error-copy">Unknown variables: {templateErrors.gitUserNameTemplate.join(", ")}</span> : null}
        </label>
        <label className="field-group">
          <span className="field-group__label">Default git user.email template</span>
          <input className="text-input" data-role="source-control-git-email-template" value={gitEmailTemplate} disabled={loading || saving} onChange={(event) => setGitEmailTemplate(event.target.value)} />
          <span className="field-group__hint">Examples: <code>orchestra+{"{role}"}{"{agent}"}@example.com</code>.</span>
          {templateErrors.gitEmailTemplate.length ? <span className="error-copy">Unknown variables: {templateErrors.gitEmailTemplate.join(", ")}</span> : null}
        </label>
      </div>

      <section className="task-section task-section--compact">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Variables</p>
            <h4>Supported template variables</h4>
          </div>
        </div>
        <div className="bridge-diagnostics-table-wrap">
          <table className="task-table" data-role="source-control-variable-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>{"{role}"}</code></td>
                <td>Current role slug in role-owned worker contexts; empty otherwise.</td>
              </tr>
              <tr>
                <td><code>{"{agent}"}</code></td>
                <td>Current agent slug in agent-owned worker contexts; empty otherwise.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="task-section task-section--compact">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Preview</p>
            <h4>Resolved git identity preview</h4>
          </div>
        </div>
        <SourceControlPreviewTable rows={previewRows} dataRole="source-control-preview-table" />
        <p className="muted-copy">Last updated: {formatDateTime(updatedAt)}</p>
      </section>
    </section>
  );
}
