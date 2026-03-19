import { useState } from "react";

import type { RoleDefinition } from "../types";

interface EnqueueRoleWorkFormProps {
  role: RoleDefinition;
  busy?: boolean;
  onSubmit: (input: { title: string; summary: string; entryPrompt: string }) => Promise<void>;
}

export function EnqueueRoleWorkForm({ role, busy, onSubmit }: EnqueueRoleWorkFormProps) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [entryPrompt, setEntryPrompt] = useState(role.systemPrompt ?? "");

  return (
    <form
      className="workflow-section workforce-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ title, summary, entryPrompt }).then(() => {
          setTitle("");
          setSummary("");
        });
      }}
    >
      <div>
        <p className="eyebrow">Manual runtime work</p>
        <h3>Enqueue role work</h3>
      </div>

      <div className="workflow-form-grid">
        <label className="field-group">
          <span className="field-group__label">Title</span>
          <input className="text-input" type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <label className="field-group">
          <span className="field-group__label">Role</span>
          <input className="text-input" type="text" value={role.name} disabled />
        </label>

        <label className="field-group workflow-form-grid__full">
          <span className="field-group__label">Summary</span>
          <textarea className="text-area" rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>

        <label className="field-group workflow-form-grid__full">
          <span className="field-group__label">Entry prompt</span>
          <textarea className="text-area" rows={5} value={entryPrompt} onChange={(event) => setEntryPrompt(event.target.value)} />
        </label>
      </div>

      <div className="action-cluster">
        <button className="primary-button" type="submit" disabled={busy || title.trim().length === 0}>
          {busy ? "Queueing…" : "Enqueue work"}
        </button>
      </div>
    </form>
  );
}
