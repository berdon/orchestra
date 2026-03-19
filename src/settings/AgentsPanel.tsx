import { useEffect, useMemo, useState } from "react";

import {
  archiveAgent,
  createAgent,
  getAgent,
  getAgentMemoryInfo,
  listAgents,
  updateAgent,
  validateAgent,
} from "../lib/agents";
import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationError,
} from "../types";

function createBlankAgentDraft(): AgentUpsertInput {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    provider: "",
    model: "",
    thinkingLevel: "off",
  };
}

function agentToDraft(agent: AgentDefinition): AgentUpsertInput {
  return {
    name: agent.name,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    provider: agent.provider ?? "",
    model: agent.model ?? "",
    thinkingLevel: agent.thinkingLevel,
  };
}

function getAgentValidationForPath(errors: AgentValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentUpsertInput>(createBlankAgentDraft);
  const [agentValidation, setAgentValidation] = useState<AgentValidationError[]>([]);
  const [agentActionError, setAgentActionError] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingAgentDetail, setLoadingAgentDetail] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [includeArchivedAgents, setIncludeArchivedAgents] = useState(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [loadedAgentId, setLoadedAgentId] = useState<string | null>(null);
  const [loadedAgentArchived, setLoadedAgentArchived] = useState(false);
  const [agentMemoryInfo, setAgentMemoryInfo] = useState<AgentMemoryInfo | null>(null);

  const selectedAgentSummary = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null,
    [selectedAgentId, agents],
  );

  const validationSummary = useMemo(() => agentValidation.map((error) => `${error.path}: ${error.message}`), [agentValidation]);

  async function loadAgents() {
    setLoadingAgents(true);
    setAgentActionError(null);

    try {
      const nextAgents = await listAgents(includeArchivedAgents);
      setAgents(nextAgents);
      setSelectedAgentId((current) => {
        if (isCreatingAgent) {
          return current;
        }

        if (current && nextAgents.some((agent) => agent.id === current)) {
          return current;
        }

        return nextAgents[0]?.id ?? null;
      });
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to load agents.");
    } finally {
      setLoadingAgents(false);
    }
  }

  async function loadAgentDetail(agentId: string) {
    setLoadingAgentDetail(true);
    setAgentActionError(null);

    try {
      const [agent, memoryInfo] = await Promise.all([getAgent(agentId), getAgentMemoryInfo(agentId)]);
      setAgentDraft(agentToDraft(agent));
      setAgentMemoryInfo(memoryInfo);
      setAgentValidation([]);
      setLoadedAgentId(agent.id);
      setLoadedAgentArchived(agent.archived);
      setIsCreatingAgent(false);
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to load agent.");
    } finally {
      setLoadingAgentDetail(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, [includeArchivedAgents]);

  useEffect(() => {
    if (isCreatingAgent) {
      return;
    }

    const agentId = selectedAgentSummary?.id;
    if (!agentId || agentId === loadedAgentId) {
      return;
    }

    void loadAgentDetail(agentId);
  }, [selectedAgentSummary?.id, isCreatingAgent, loadedAgentId]);

  async function refreshAgentValidation(nextDraft: AgentUpsertInput) {
    try {
      const validation = await validateAgent(nextDraft);
      setAgentValidation(validation.errors);
      return validation.errors;
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to validate agent.");
      return [];
    }
  }

  function updateAgentDraft(updater: (draft: AgentUpsertInput) => AgentUpsertInput) {
    setAgentDraft((current) => {
      const next = updater(current);
      void refreshAgentValidation(next);
      return next;
    });
  }

  function beginCreateAgent() {
    setSelectedAgentId(null);
    setAgentDraft(createBlankAgentDraft());
    setAgentValidation([]);
    setAgentActionError(null);
    setAgentMemoryInfo(null);
    setLoadedAgentId(null);
    setLoadedAgentArchived(false);
    setIsCreatingAgent(true);
  }

  async function handleSaveAgent() {
    setSavingAgent(true);
    setAgentActionError(null);

    try {
      const validation = await validateAgent(agentDraft);
      setAgentValidation(validation.errors);
      if (!validation.valid) {
        setAgentActionError("Fix the agent validation errors before saving.");
        return;
      }

      const saved = loadedAgentId && !isCreatingAgent ? await updateAgent(loadedAgentId, agentDraft) : await createAgent(agentDraft);

      await loadAgents();
      setSelectedAgentId(saved.id);
      setLoadedAgentId(saved.id);
      setLoadedAgentArchived(saved.archived);
      setAgentDraft(agentToDraft(saved));
      setAgentValidation([]);
      setIsCreatingAgent(false);
      setAgentMemoryInfo(await getAgentMemoryInfo(saved.id));
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to save agent.");
    } finally {
      setSavingAgent(false);
    }
  }

  async function handleArchiveAgent() {
    if (!selectedAgentSummary) {
      return;
    }

    setSavingAgent(true);
    setAgentActionError(null);
    try {
      const archived = await archiveAgent(selectedAgentSummary.id);
      await loadAgents();
      setSelectedAgentId(archived.id);
      await loadAgentDetail(archived.id);
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to archive agent.");
    } finally {
      setSavingAgent(false);
    }
  }

  return (
    <section className="role-shell">
      <aside className="role-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Agent library</p>
            <h3>Agents</h3>
          </div>
          <div className="action-cluster">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeArchivedAgents}
                onChange={(event) => setIncludeArchivedAgents(event.target.checked)}
              />
              Show archived
            </label>
            <button className="primary-button" data-role="new-agent" type="button" onClick={beginCreateAgent}>
              New agent
            </button>
          </div>
        </div>

        {loadingAgents ? <p className="muted-copy">Loading agents…</p> : null}
        {agentActionError ? <p className="error-copy">{agentActionError}</p> : null}

        <nav className="role-list" aria-label="Agents">
          {agents.map((agent) => (
            <a
              key={agent.id}
              className={agent.id === selectedAgentSummary?.id && !isCreatingAgent ? "role-list-link role-list-link--active" : "role-list-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedAgentId(agent.id);
              }}
            >
              {agent.name}
              <span className="role-list-link__meta">{agent.slug}</span>
            </a>
          ))}
        </nav>
      </aside>

      <section className="panel role-detail-panel">
        {selectedAgentSummary || isCreatingAgent ? (
          <div className="workflow-editor-grid">
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Agent definition</p>
                <h3>{isCreatingAgent ? "Create agent" : agentDraft.name.trim() || "Untitled agent"}</h3>
              </div>
              <div className="action-cluster">
                {agentMemoryInfo ? <span className="status-badge status-badge--accent">{agentMemoryInfo.slug}</span> : null}
                {loadedAgentArchived ? <span className="status-badge status-badge--neutral">Archived</span> : null}
                {!isCreatingAgent && loadedAgentId ? (
                  <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleArchiveAgent()} disabled={savingAgent || loadedAgentArchived}>
                    Archive agent
                  </button>
                ) : null}
                <button className="primary-button" data-role="save-agent" type="button" onClick={() => void handleSaveAgent()} disabled={savingAgent || loadingAgentDetail}>
                  {savingAgent ? "Saving…" : isCreatingAgent ? "Create agent" : "Save changes"}
                </button>
              </div>
            </div>

            {loadingAgentDetail ? <p className="muted-copy">Loading agent…</p> : null}

            <section className="workflow-section">
              <div>
                <p className="eyebrow">Execution defaults</p>
                <h3>Configuration</h3>
              </div>

              <div className="workflow-form-grid">
                <label className="field-group">
                  <span className="field-group__label">Agent name</span>
                  <input
                    className="text-input"
                    data-role="agent-name"
                    type="text"
                    value={agentDraft.name}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, name: event.target.value }))}
                  />
                  {getAgentValidationForPath(agentValidation, "name").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Provider</span>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="e.g. anthropic"
                    value={agentDraft.provider ?? ""}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, provider: event.target.value }))}
                  />
                  {getAgentValidationForPath(agentValidation, "provider").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Model</span>
                  <input
                    className="text-input"
                    type="text"
                    placeholder="e.g. claude-sonnet-4-20250514"
                    value={agentDraft.model ?? ""}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, model: event.target.value }))}
                  />
                  {getAgentValidationForPath(agentValidation, "model").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Thinking</span>
                  <select
                    className="select-input"
                    value={agentDraft.thinkingLevel ?? "off"}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, thinkingLevel: event.target.value }))}
                  >
                    <option value="off">Off</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  {getAgentValidationForPath(agentValidation, "thinkingLevel").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group workflow-form-grid__full">
                  <span className="field-group__label">Description</span>
                  <textarea
                    className="text-area"
                    rows={3}
                    value={agentDraft.description ?? ""}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, description: event.target.value }))}
                  />
                </label>

                <label className="field-group workflow-form-grid__full">
                  <span className="field-group__label">System prompt</span>
                  <textarea
                    className="text-area"
                    rows={8}
                    value={agentDraft.systemPrompt ?? ""}
                    onChange={(event) => updateAgentDraft((draft) => ({ ...draft, systemPrompt: event.target.value }))}
                  />
                </label>
              </div>
            </section>

            {agentMemoryInfo ? (
              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Persistent files</p>
                  <h3>Memory bootstrap</h3>
                </div>
                <ul className="workflow-validation-list">
                  <li data-role="agent-memory-root">Root: {agentMemoryInfo.rootDir}</li>
                  <li>AGENTS.md: {agentMemoryInfo.agentsPath}</li>
                  <li>IDENTITY.md: {agentMemoryInfo.identityPath}</li>
                  <li>SOUL.md: {agentMemoryInfo.soulPath}</li>
                  <li>MEMORY.md: {agentMemoryInfo.memoryPath}</li>
                  <li>TOOLS.md: {agentMemoryInfo.toolsPath}</li>
                  <li>Daily logs: {agentMemoryInfo.dailyMemoryDir}</li>
                </ul>
              </section>
            ) : null}

            {validationSummary.length > 0 ? (
              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Validation</p>
                  <h3>Resolve these issues before saving</h3>
                </div>
                <ul className="workflow-validation-list">
                  {validationSummary.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No agent selected</p>
            <h3>Create or select an agent</h3>
            <p>Use the agent list to inspect an existing definition or create a persistent global worker.</p>
          </div>
        )}
      </section>
    </section>
  );
}
