import { useEffect, useMemo, useState } from "react";

import { AccessEditor } from "../components/access/AccessEditor";
import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SettingsMobileSubnavHeader } from "../components/SettingsMobileSubnavHeader";
import { SettingsSectionTabs } from "../components/SettingsSectionTabs";
import type { InheritedAccessSummary } from "../components/access/AccessSummary";
import { buildEffectivePermissions, getPolicyLabel } from "../lib/access";
import {
  archiveAgent,
  createAgent,
  getAgent,
  getAgentMemoryInfo,
  listAgents,
  updateAgent,
  validateAgent,
} from "../lib/agents";
import { getPolicy, listPolicies } from "../lib/policies";
import { getAgentSkillLinks } from "../lib/skills";
import { getWorkerOverlay, updateWorkerOverlay } from "../lib/projectSettings";
import { listRoles } from "../lib/roles";
import { getPiExecutableDiagnostic, listPiModels, reportClientError } from "../lib/tauri";
import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentSkillLinks,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationError,
  PiExecutableDiagnostic,
  PiSetupState,
  PolicyDefinition,
  ProjectWorkerOverlay,
  RoleSummary,
  SessionModel,
} from "../types";

function createBlankAgentDraft(activeProjectId?: string | null): AgentUpsertInput {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    provider: "",
    model: "",
    thinkingLevel: "off",
    roleId: null,
    scope: "global",
    projectId: activeProjectId ?? null,
    compactionWindow: "",
    policyIds: [],
    directPermissions: [],
  };
}

function agentToDraft(agent: AgentDefinition): AgentUpsertInput {
  return {
    name: agent.name,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    provider: agent.provider ?? "",
    model: agent.model ?? "",
    roleId: agent.roleId ?? null,
    scope: agent.scope,
    projectId: agent.projectId ?? null,
    thinkingLevel: agent.thinkingLevel,
    compactionWindow: agent.compactionWindow ?? "",
    policyIds: agent.policyIds ?? [],
    directPermissions: agent.directPermissions ?? [],
  };
}

function getAgentValidationForPath(errors: AgentValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

function formatPiRuntimeDiagnostic(diagnostic: PiExecutableDiagnostic | null) {
  if (!diagnostic) {
    return "Loading…";
  }

  if (diagnostic.status !== "healthy") {
    const kind = diagnostic.errorKind ? ` (${diagnostic.errorKind})` : "";
    return `Pi runtime error${kind}: ${diagnostic.errorMessage ?? "Unknown runtime error."}`;
  }

  const version = diagnostic.version ? ` ${diagnostic.version}` : "";
  return `${diagnostic.source} runtime${version}: ${diagnostic.resolvedPath ?? "Unknown path"}`;
}

export function AgentsPanel({ activeProjectId = null, piSetupState = null, onOpenPiSettings, onOpenSkill, canReadSkills = false }: { activeProjectId?: string | null; piSetupState?: PiSetupState | null; onOpenPiSettings?: () => void; onOpenSkill?: (skillId: string) => void; canReadSkills?: boolean }) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentUpsertInput>(() => createBlankAgentDraft(activeProjectId));
  const [agentValidation, setAgentValidation] = useState<AgentValidationError[]>([]);
  const [agentActionError, setAgentActionError] = useState<string | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingAgentDetail, setLoadingAgentDetail] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [includeArchivedAgents, setIncludeArchivedAgents] = useState(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [loadedAgentId, setLoadedAgentId] = useState<string | null>(null);
  const [loadedAgentArchived, setLoadedAgentArchived] = useState(false);
  const [loadedAgentProtected, setLoadedAgentProtected] = useState(false);
  const [availableModels, setAvailableModels] = useState<SessionModel[]>([]);
  const [piExecutableDiagnostic, setPiExecutableDiagnostic] = useState<PiExecutableDiagnostic | null>(null);
  const [loadingModelOptions, setLoadingModelOptions] = useState(false);
  const [agentMemoryInfo, setAgentMemoryInfo] = useState<AgentMemoryInfo | null>(null);
  const [projectOverlay, setProjectOverlay] = useState<ProjectWorkerOverlay | null>(null);
  const [overlayDraft, setOverlayDraft] = useState("");
  const [savingOverlay, setSavingOverlay] = useState(false);
  const [policyDefinitions, setPolicyDefinitions] = useState<PolicyDefinition[]>([]);
  const [skillLinks, setSkillLinks] = useState<AgentSkillLinks | null>(null);

  const selectedAgentSummary = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null,
    [selectedAgentId, agents],
  );

  const validationSummary = useMemo(() => agentValidation.map((error) => `${error.path}: ${error.message}`), [agentValidation]);
  const providerOptions = useMemo(
    () => Array.from(new Set(availableModels.map((model) => model.provider))).sort(),
    [availableModels],
  );
  const filteredModelOptions = useMemo(
    () => availableModels.filter((model) => !agentDraft.provider || model.provider === agentDraft.provider),
    [availableModels, agentDraft.provider],
  );
  const attachedPolicies = useMemo(
    () => policyDefinitions.filter((policy) => agentDraft.policyIds?.includes(policy.id)),
    [policyDefinitions, agentDraft.policyIds],
  );
  const inheritedRole = useMemo(
    () => roles.find((role) => role.id === agentDraft.roleId) ?? null,
    [roles, agentDraft.roleId],
  );
  const inheritedPolicies = useMemo(
    () => policyDefinitions.filter((policy) => inheritedRole?.policyIds?.includes(policy.id)),
    [policyDefinitions, inheritedRole?.policyIds],
  );
  const inheritedEffective = useMemo(
    () =>
      inheritedRole
        ? buildEffectivePermissions({
            attachedPolicies: inheritedPolicies,
            directPermissions: inheritedRole.directPermissions,
          })
        : { permissions: [], grantsFullAccess: false },
    [inheritedPolicies, inheritedRole],
  );
  const inheritedAccess = useMemo<InheritedAccessSummary | null>(() => {
    if (!inheritedRole) {
      return null;
    }

    return {
      sourceLabel: inheritedRole.name,
      permissions: inheritedEffective.permissions,
      policyNames: inheritedPolicies.map((policy) => getPolicyLabel(policy)),
      grantsFullAccess: inheritedEffective.grantsFullAccess,
    };
  }, [inheritedEffective.grantsFullAccess, inheritedEffective.permissions, inheritedPolicies, inheritedRole]);
  const effectiveAccess = useMemo(
    () =>
      buildEffectivePermissions({
        inheritedPermissions: inheritedEffective.permissions,
        attachedPolicies,
        directPermissions: agentDraft.directPermissions,
      }),
    [agentDraft.directPermissions, attachedPolicies, inheritedEffective.permissions],
  );

  async function loadAgents() {
    setLoadingAgents(true);
    setAgentActionError(null);

    try {
      const nextAgents = await listAgents(includeArchivedAgents, activeProjectId);
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
      const agent = await getAgent(agentId, activeProjectId);
      setAgentDraft(agentToDraft(agent));
      setAgentValidation([]);
      setLoadedAgentId(agent.id);
      setLoadedAgentArchived(agent.archived);
      setLoadedAgentProtected(Boolean(agent.system || agent.immutable || agent.slug === "supervisor"));
      setAgentMemoryInfo(null);
      setProjectOverlay(null);
      setOverlayDraft("");
      setIsCreatingAgent(false);
      setLoadingAgentDetail(false);

      void Promise.allSettled([getAgentMemoryInfo(agentId), getWorkerOverlay("agent", agent.slug)])
        .then(([memoryResult, overlayResult]) => {
          if (memoryResult.status === "fulfilled") {
            setAgentMemoryInfo(memoryResult.value);
          } else {
            setAgentMemoryInfo(null);
          }

          if (overlayResult.status === "fulfilled") {
            setProjectOverlay(overlayResult.value);
            setOverlayDraft(overlayResult.value.prompt ?? "");
            return;
          }

          throw overlayResult.reason;
        })
        .catch((error) => {
          setAgentActionError(error instanceof Error ? error.message : "Unable to load agent details.");
        });
      return;
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to load agent.");
    }

    setLoadingAgentDetail(false);
  }

  useEffect(() => {
    void loadAgents();
  }, [includeArchivedAgents, activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingModelOptions(true);

    void getPiExecutableDiagnostic()
      .then((diagnostic) => {
        if (!cancelled) {
          setPiExecutableDiagnostic(diagnostic);
        }
      })
      .catch(async (error) => {
        if (!cancelled) {
          const message = await reportClientError("ui.agents.pi_runtime.load", error, "Unable to load Pi runtime diagnostics.");
          setPiExecutableDiagnostic({
            source: "unknown",
            mode: "unknown",
            status: "runtime_error",
            resolvedPath: null,
            packageDir: null,
            agentDir: null,
            version: null,
            builtAt: null,
            manifestPath: null,
            errorKind: "runtime_diagnostic_unavailable",
            errorMessage: message,
          });
        }
      });

    void listPiModels()
      .then((models) => {
        if (!cancelled) {
          setAvailableModels(models);
        }
      })
      .catch(async (error) => {
        if (!cancelled) {
          setAgentActionError(await reportClientError("ui.agents.pi_models.load", error, "Unable to load PI models."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModelOptions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listPolicies()
      .then((summaries) => Promise.all(summaries.map((summary) => getPolicy(summary.id))))
      .then((definitions) => {
        if (!cancelled) {
          setPolicyDefinitions(definitions);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentActionError(error instanceof Error ? error.message : "Unable to load policy definitions.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isCreatingAgent) {
      setAgentDraft((current) => (current.scope === "project" ? { ...current, projectId: activeProjectId ?? null } : current));
    }
  }, [activeProjectId, isCreatingAgent]);

  useEffect(() => {
    let cancelled = false;
    void listRoles(true)
      .then((nextRoles) => {
        if (!cancelled) {
          setRoles(nextRoles);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentActionError(error instanceof Error ? error.message : "Unable to load roles for inherited access.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isCreatingAgent) {
      return;
    }

    const agentId = selectedAgentSummary?.id;
    if (!agentId || agentId === loadedAgentId) {
      return;
    }

    void loadAgentDetail(agentId);
  }, [selectedAgentSummary?.id, isCreatingAgent, loadedAgentId, activeProjectId]);

  useEffect(() => {
    if (!canReadSkills || isCreatingAgent || !selectedAgentSummary?.id) {
      setSkillLinks(null);
      return;
    }

    let cancelled = false;
    void getAgentSkillLinks(selectedAgentSummary.id)
      .then((links) => {
        if (!cancelled) {
          setSkillLinks(links);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAgentActionError(error instanceof Error ? error.message : "Unable to load linked skills.");
          setSkillLinks(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canReadSkills, isCreatingAgent, selectedAgentSummary?.id]);

  async function refreshAgentValidation(nextDraft: AgentUpsertInput) {
    try {
      const validation = await validateAgent({
        ...nextDraft,
        projectId: nextDraft.scope === "project" ? activeProjectId ?? nextDraft.projectId ?? null : null,
      });
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
    setAgentDraft(createBlankAgentDraft(activeProjectId));
    setAgentValidation([]);
    setAgentActionError(null);
    setAgentMemoryInfo(null);
    setProjectOverlay(null);
    setOverlayDraft("");
    setLoadedAgentId(null);
    setLoadedAgentArchived(false);
    setLoadedAgentProtected(false);
    setIsCreatingAgent(true);
  }

  async function handleSaveAgent() {
    setSavingAgent(true);
    setAgentActionError(null);

    try {
      const validation = await validateAgent({ ...agentDraft, projectId: agentDraft.scope === "project" ? activeProjectId ?? agentDraft.projectId ?? null : null });
      setAgentValidation(validation.errors);
      if (!validation.valid) {
        setAgentActionError("Fix the agent validation errors before saving.");
        return;
      }

      const saveInput = { ...agentDraft, projectId: agentDraft.scope === "project" ? activeProjectId ?? agentDraft.projectId ?? null : null };
      const saved = loadedAgentId && !isCreatingAgent ? await updateAgent(loadedAgentId, saveInput) : await createAgent(saveInput);

      await loadAgents();
      setSelectedAgentId(saved.id);
      setLoadedAgentId(saved.id);
      setLoadedAgentArchived(saved.archived);
      setLoadedAgentProtected(Boolean(saved.system || saved.immutable || saved.slug === "supervisor"));
      setAgentDraft(agentToDraft(saved));
      setAgentValidation([]);
      setIsCreatingAgent(false);

      void Promise.all([getAgentMemoryInfo(saved.id), getWorkerOverlay("agent", saved.slug)])
        .then(([memoryInfo, overlay]) => {
          setAgentMemoryInfo(memoryInfo);
          setProjectOverlay(overlay);
          setOverlayDraft(overlay.prompt ?? "");
        })
        .catch((error) => {
          setAgentActionError(error instanceof Error ? error.message : "Unable to load saved agent details.");
        });
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to save agent.");
    } finally {
      setSavingAgent(false);
    }
  }

  async function handleSaveOverlay() {
    if (!agentMemoryInfo) {
      return;
    }

    setSavingOverlay(true);
    setAgentActionError(null);
    try {
      const saved = await updateWorkerOverlay("agent", agentMemoryInfo.slug, overlayDraft);
      setProjectOverlay(saved);
      setOverlayDraft(saved.prompt ?? "");
    } catch (error) {
      setAgentActionError(error instanceof Error ? error.message : "Unable to save project overlay.");
    } finally {
      setSavingOverlay(false);
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

  const agentMobileActions = [
    {
      id: "toggle-archived-agents",
      label: includeArchivedAgents ? "Hide archived agents" : "Show archived agents",
      onClick: () => setIncludeArchivedAgents((current) => !current),
      variant: "secondary" as const,
    },
    {
      id: "new-agent",
      label: "New agent",
      onClick: beginCreateAgent,
      variant: "secondary" as const,
    },
    ...(!isCreatingAgent && loadedAgentId && !loadedAgentProtected
      ? [{
          id: "archive-agent",
          label: "Archive agent",
          onClick: () => void handleArchiveAgent(),
          disabled: savingAgent || loadedAgentArchived,
          variant: "danger" as const,
        }]
      : []),
    {
      id: "save-agent",
      label: savingAgent ? "Saving…" : isCreatingAgent ? "Create agent" : "Save changes",
      onClick: () => void handleSaveAgent(),
      disabled: savingAgent || loadingAgentDetail,
      variant: "primary" as const,
    },
  ];

  return (
    <>
      <SettingsMobileSubnavHeader
        dataRolePrefix="agent"
        selectLabel="Agent"
        ariaLabel="Agent selection"
        value={isCreatingAgent ? null : selectedAgentSummary?.id ?? null}
        emptyOptionLabel={isCreatingAgent ? "Create agent" : "Select agent"}
        options={agents.map((agent) => ({ id: agent.id, label: agent.name }))}
        onChange={(agentId) => {
          if (agentId) {
            setSelectedAgentId(agentId);
            setIsCreatingAgent(false);
          }
        }}
        actions={agentMobileActions}
        actionMenuLabel="Agent actions"
      />
      <ResizableSidebarLayout
      className="role-shell"
      storageKey="orchestra.layout.agents.secondary-nav-width"
      navigationClassName="role-nav-panel settings-mobile-subnav-panel"
      detailClassName="panel role-detail-panel"
      navigation={(
      <>
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Agent library</p>
            <h3>Agents</h3>
          </div>
          <div className="action-cluster settings-mobile-subnav-redundant-actions">
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

        <nav className="role-list settings-mobile-subnav-list" aria-label="Agents">
          {agents.map((agent) => (
            <a
              key={agent.id}
              className={agent.id === selectedAgentSummary?.id && !isCreatingAgent ? "role-list-link role-list-link--active" : "role-list-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedAgentId(agent.id);
                setIsCreatingAgent(false);
              }}
            >
              <span data-role={`agent-list-name-${agent.slug}`} style={agent.scope === "global" ? { fontWeight: 700, fontStyle: "italic" } : undefined}>
                {agent.name}
              </span>
              <span className="role-list-link__meta">{agent.system ? "System global agent" : agent.scope === "global" ? "Global agent" : "Project agent"}</span>
            </a>
          ))}
        </nav>
      </>
      )}
      detail={(
      <>
        {selectedAgentSummary || isCreatingAgent ? (
          <SettingsSectionTabs
            className="workflow-editor-grid"
            ariaLabel="Agent settings sections"
            dataRolePrefix="agent-detail"
            initialTabId="configuration"
            header={(
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">Agent definition</p>
                  <h3>{isCreatingAgent ? "Create agent" : agentDraft.name.trim() || "Untitled agent"}</h3>
                </div>
                <div className="action-cluster settings-mobile-subnav-redundant-actions">
                  {agentMemoryInfo ? <span className="status-badge status-badge--accent">{agentMemoryInfo.slug}</span> : null}
                  {loadedAgentProtected ? <span className="status-badge status-badge--warning" data-role="agent-protected-badge">Protected</span> : null}
                  <span className="status-badge status-badge--neutral" data-role="agent-scope-badge">{loadedAgentProtected && !isCreatingAgent ? "Global" : agentDraft.scope === "project" ? "Project specific" : "Global"}</span>
                  {loadedAgentArchived ? <span className="status-badge status-badge--neutral">Archived</span> : null}
                  {!isCreatingAgent && loadedAgentId && !loadedAgentProtected ? (
                    <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleArchiveAgent()} disabled={savingAgent || loadedAgentArchived}>
                      Archive agent
                    </button>
                  ) : null}
                  <button className="primary-button" data-role="save-agent" type="button" onClick={() => void handleSaveAgent()} disabled={savingAgent || loadingAgentDetail}>
                    {savingAgent ? "Saving…" : isCreatingAgent ? "Create agent" : "Save changes"}
                  </button>
                </div>
              </div>
            )}
            leadingContent={loadingAgentDetail ? <p className="muted-copy">Loading agent…</p> : null}
            tabs={[
              {
                id: "configuration",
                label: "Configuration",
                panel: (
                  <section className="workflow-section">
                    <div>
                      <p className="eyebrow">Execution defaults</p>
                      <h3>Configuration</h3>
                    </div>

                    <div className="workflow-form-grid">
                      <label className="field-group">
                        <span className="field-group__label">Scope</span>
                        <select
                          className="select-input"
                          data-role="agent-scope"
                          value={loadedAgentProtected && !isCreatingAgent ? "global" : agentDraft.scope ?? "global"}
                          disabled={loadedAgentProtected && !isCreatingAgent}
                          onChange={(event) =>
                            updateAgentDraft((draft) => ({
                              ...draft,
                              scope: event.target.value === "project" ? "project" : "global",
                              projectId: event.target.value === "project" ? activeProjectId ?? draft.projectId ?? null : null,
                            }))
                          }
                        >
                          <option value="global">Global</option>
                          <option value="project" disabled={!activeProjectId}>Project specific</option>
                        </select>
                        {getAgentValidationForPath(agentValidation, "scope").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Owning project</span>
                        <input
                          className="text-input"
                          data-role="agent-project-scope"
                          type="text"
                          value={agentDraft.scope === "project" ? activeProjectId ?? agentDraft.projectId ?? "" : "All projects"}
                          disabled
                        />
                        {getAgentValidationForPath(agentValidation, "projectId").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Agent name</span>
                        <input
                          className="text-input"
                          data-role="agent-name"
                          type="text"
                          value={agentDraft.name}
                          disabled={loadedAgentProtected && !isCreatingAgent}
                          onChange={(event) => updateAgentDraft((draft) => ({ ...draft, name: event.target.value }))}
                        />
                        {getAgentValidationForPath(agentValidation, "name").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Provider</span>
                        <select
                          className="select-input"
                          data-role="agent-provider"
                          value={agentDraft.provider ?? ""}
                          disabled={loadingModelOptions || piSetupState?.status !== "ready"}
                          onChange={(event) =>
                            updateAgentDraft((draft) => ({
                              ...draft,
                              provider: event.target.value,
                              model: draft.provider === event.target.value ? draft.model : "",
                            }))
                          }
                        >
                          <option value="">{loadingModelOptions ? "Loading providers…" : "Select a provider"}</option>
                          {providerOptions.map((provider) => (
                            <option key={provider} value={provider}>
                              {provider}
                            </option>
                          ))}
                        </select>
                        {getAgentValidationForPath(agentValidation, "provider").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Model</span>
                        <select
                          className="select-input"
                          data-role="agent-model"
                          value={agentDraft.model ?? ""}
                          disabled={loadingModelOptions || piSetupState?.status !== "ready" || !(agentDraft.provider ?? "")}
                          onChange={(event) => updateAgentDraft((draft) => ({ ...draft, model: event.target.value }))}
                        >
                          <option value="">
                            {loadingModelOptions ? "Loading models…" : agentDraft.provider ? "Select a model" : "Select a provider first"}
                          </option>
                          {filteredModelOptions.map((model) => (
                            <option key={`${model.provider}/${model.id}`} value={model.id}>
                              {model.name}
                            </option>
                          ))}
                        </select>
                        {getAgentValidationForPath(agentValidation, "model").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Thinking</span>
                        <select
                          className="select-input"
                          data-role="agent-thinking"
                          value={agentDraft.thinkingLevel ?? "off"}
                          onChange={(event) => updateAgentDraft((draft) => ({ ...draft, thinkingLevel: event.target.value }))}
                        >
                          <option value="off">Off</option>
                          <option value="minimal">Minimal</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="xhigh">XHigh</option>
                        </select>
                        {getAgentValidationForPath(agentValidation, "thinkingLevel").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <label className="field-group">
                        <span className="field-group__label">Compaction window override</span>
                        <input
                          className="text-input"
                          data-role="agent-compaction-window"
                          type="text"
                          placeholder="Inherit global/role default"
                          value={agentDraft.compactionWindow ?? ""}
                          onChange={(event) => updateAgentDraft((draft) => ({ ...draft, compactionWindow: event.target.value }))}
                        />
                        <span className="field-group__hint">Optional. Use `10%`, a token reserve like `16000`, `off`, or leave blank to inherit.</span>
                        {getAgentValidationForPath(agentValidation, "compactionWindow").map((error) => (
                          <span className="field-error" key={error.message}>{error.message}</span>
                        ))}
                      </label>

                      <div className="workflow-form-grid__full muted-copy" data-role="agent-pi-executable-diagnostic">
                        Pi runtime: {formatPiRuntimeDiagnostic(piExecutableDiagnostic)}
                      </div>

                      {piSetupState?.status && piSetupState.status !== "ready" ? (
                        <div className="workflow-form-grid__full session-readonly-banner">
                          <div>
                            <strong>Pi setup required.</strong> {piSetupState.issues[0]?.message ?? piSetupState.warnings[0]?.message ?? "Connect a provider in Settings → Harness before assigning Pi-backed agent models."}
                          </div>
                          {onOpenPiSettings ? (
                            <button className="secondary-button" type="button" onClick={onOpenPiSettings}>
                              Open Settings → Harness
                            </button>
                          ) : null}
                        </div>
                      ) : null}

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
                          disabled={loadedAgentProtected && !isCreatingAgent}
                          onChange={(event) => updateAgentDraft((draft) => ({ ...draft, systemPrompt: event.target.value }))}
                        />
                      </label>
                    </div>
                  </section>
                ),
              },
              {
                id: "access",
                label: "Access",
                panel: (
                  <>
                    <AccessEditor
                      actorLabel="agent"
                      dataRolePrefix="agent"
                      policyIds={agentDraft.policyIds ?? []}
                      directPermissions={agentDraft.directPermissions ?? []}
                      attachedPolicies={attachedPolicies}
                      effectivePermissions={effectiveAccess.permissions}
                      grantsFullAccess={effectiveAccess.grantsFullAccess}
                      inheritedAccess={inheritedAccess}
                      locked={loadedAgentProtected && !isCreatingAgent}
                      onPolicyIdsChange={(policyIds) => updateAgentDraft((draft) => ({ ...draft, policyIds }))}
                      onDirectPermissionsChange={(directPermissions) => updateAgentDraft((draft) => ({ ...draft, directPermissions }))}
                    />
                    <p className="muted-copy">Permissions assigned here are combined with any inherited role access.</p>
                  </>
                ),
              },
              {
                id: "skills",
                label: "Skills",
                panel: canReadSkills ? (
                  <section className="workflow-section">
                    <div>
                      <p className="eyebrow">Managed skills</p>
                      <h3>Linked skills</h3>
                    </div>
                    <div className="skills-linked-surface-grid">
                      <div>
                        <strong>Direct</strong>
                        {skillLinks?.directSkills.length ? (
                          <div className="skills-binding-chip-list">
                            {skillLinks.directSkills.map((skill) => (
                              onOpenSkill ? (
                                <button className="task-tag-chip task-tag-chip--interactive" data-role={`agent-direct-skill-${skill.skillId}`} key={skill.bindingId} type="button" onClick={() => onOpenSkill(skill.skillId)}>
                                  <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                                </button>
                              ) : (
                                <span className="task-tag-chip" data-role={`agent-direct-skill-${skill.skillId}`} key={skill.bindingId}>
                                  <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                                </span>
                              )
                            ))}
                          </div>
                        ) : (
                          <p className="muted-copy">No direct agent bindings.</p>
                        )}
                      </div>
                      {skillLinks?.inheritedRoleId ? (
                        <div>
                          <strong>Inherited from role{skillLinks.inheritedRoleName ? ` · ${skillLinks.inheritedRoleName}` : ""}</strong>
                          {skillLinks.inheritedRoleSkills.length ? (
                            <div className="skills-binding-chip-list">
                              {skillLinks.inheritedRoleSkills.map((skill) => (
                                onOpenSkill ? (
                                  <button className="task-tag-chip task-tag-chip--interactive" data-role={`agent-inherited-skill-${skill.skillId}`} key={skill.bindingId} type="button" onClick={() => onOpenSkill(skill.skillId)}>
                                    <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                                  </button>
                                ) : (
                                  <span className="task-tag-chip" data-role={`agent-inherited-skill-${skill.skillId}`} key={skill.bindingId}>
                                    <span className="task-tag-chip__action"><span>{skill.skillName}</span></span>
                                  </span>
                                )
                              ))}
                            </div>
                          ) : (
                            <p className="muted-copy">No inherited role bindings.</p>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <p className="muted-copy">Assignments remain editable only in Settings → Skills.</p>
                  </section>
                ) : (
                  <section className="workflow-section">
                    <div>
                      <p className="eyebrow">Managed skills</p>
                      <h3>Linked skills</h3>
                    </div>
                    <p className="muted-copy">Managed skill links are unavailable with the current permissions.</p>
                  </section>
                ),
              },
              {
                id: "memory",
                label: "Memory",
                hidden: !agentMemoryInfo,
                panel: agentMemoryInfo ? (
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
                ) : null,
              },
              {
                id: "overlay",
                label: "Overlay",
                hidden: !projectOverlay,
                panel: projectOverlay ? (
                  <section className="workflow-section">
                    <div className="workflow-section__header">
                      <div>
                        <p className="eyebrow">Project overlay</p>
                        <h3>{projectOverlay.projectSlug}</h3>
                      </div>
                      <button className="primary-button" data-role="save-agent-overlay" type="button" onClick={() => void handleSaveOverlay()} disabled={savingOverlay}>
                        {savingOverlay ? "Saving…" : "Save overlay"}
                      </button>
                    </div>
                    <label className="field-group workflow-form-grid__full">
                      <span className="field-group__label">Project prompt additions</span>
                      <textarea
                        className="text-area"
                        data-role="agent-overlay-prompt"
                        rows={5}
                        value={overlayDraft}
                        onChange={(event) => setOverlayDraft(event.target.value)}
                      />
                    </label>
                    {loadedAgentProtected ? <p className="muted-copy">Supervisor identity fields are locked. Provider, model, thinking, and project overlay remain editable.</p> : null}
                    {projectOverlay.updatedAt ? <p className="muted-copy">Last updated {projectOverlay.updatedAt}</p> : null}
                  </section>
                ) : null,
              },
              {
                id: "validation",
                label: "Validation",
                hidden: validationSummary.length === 0,
                panel: validationSummary.length > 0 ? (
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
                ) : null,
              },
            ]}
          />
        ) : (
          <div className="empty-state">
            <p className="eyebrow">No agent selected</p>
            <h3>Create or select an agent</h3>
            <p>Use the agent list to inspect an existing definition or create a persistent global or project-specific worker.</p>
          </div>
        )}
      </>
      )}
    />
    </>
  );
}
