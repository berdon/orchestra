import { useEffect, useMemo, useRef, useState } from "react";

import { AccessEditor } from "../components/access/AccessEditor";
import { buildEffectivePermissions, getPolicyLabel } from "../lib/access";
import { getPolicy, listPolicies } from "../lib/policies";
import { archiveRole, createRole, getRole, listRoles, updateRole, validateRole } from "../lib/roles";
import { getPiExecutableDiagnostic, listPiModels } from "../lib/tauri";
import type {
  PiExecutableDiagnostic,
  PolicyDefinition,
  RoleDefinition,
  RoleSummary,
  RoleUpsertInput,
  RoleValidationError,
  SessionModel,
} from "../types";

function createBlankRoleDraft(): RoleUpsertInput {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    provider: "",
    model: "",
    thinkingLevel: "off",
    capacity: 1,
    policyIds: [],
    directPermissions: [],
  };
}

function roleToDraft(role: RoleDefinition): RoleUpsertInput {
  return {
    name: role.name,
    description: role.description ?? "",
    systemPrompt: role.systemPrompt ?? "",
    provider: role.provider ?? "",
    model: role.model ?? "",
    thinkingLevel: role.thinkingLevel,
    capacity: role.capacity,
    policyIds: role.policyIds ?? [],
    directPermissions: role.directPermissions ?? [],
  };
}

function getRoleValidationForPath(errors: RoleValidationError[], path: string) {
  return errors.filter((error) => error.path === path);
}

interface RolesPanelProps {
  selectionRequest?: { roleId: string; token: number } | null;
}

export function RolesPanel({ selectionRequest = null }: RolesPanelProps) {
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleUpsertInput>(createBlankRoleDraft);
  const [roleValidation, setRoleValidation] = useState<RoleValidationError[]>([]);
  const [roleActionError, setRoleActionError] = useState<string | null>(null);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [loadingRoleDetail, setLoadingRoleDetail] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [includeArchivedRoles, setIncludeArchivedRoles] = useState(false);
  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [loadedRoleId, setLoadedRoleId] = useState<string | null>(null);
  const [loadedRoleArchived, setLoadedRoleArchived] = useState(false);
  const [availableModels, setAvailableModels] = useState<SessionModel[]>([]);
  const [piExecutableDiagnostic, setPiExecutableDiagnostic] = useState<PiExecutableDiagnostic | null>(null);
  const [loadingModelOptions, setLoadingModelOptions] = useState(false);
  const [policyDefinitions, setPolicyDefinitions] = useState<PolicyDefinition[]>([]);
  const selectionRequestTokenRef = useRef<number>(0);

  const selectedRoleSummary = useMemo(
    () => roles.find((role) => role.id === selectedRoleId) ?? roles[0] ?? null,
    [selectedRoleId, roles],
  );

  const validationSummary = useMemo(() => roleValidation.map((error) => `${error.path}: ${error.message}`), [roleValidation]);
  const providerOptions = useMemo(
    () => Array.from(new Set(availableModels.map((model) => model.provider))).sort(),
    [availableModels],
  );
  const filteredModelOptions = useMemo(
    () => availableModels.filter((model) => !roleDraft.provider || model.provider === roleDraft.provider),
    [availableModels, roleDraft.provider],
  );
  const attachedPolicies = useMemo(
    () => policyDefinitions.filter((policy) => roleDraft.policyIds?.includes(policy.id)),
    [policyDefinitions, roleDraft.policyIds],
  );
  const effectiveAccess = useMemo(
    () => buildEffectivePermissions({ attachedPolicies, directPermissions: roleDraft.directPermissions }),
    [attachedPolicies, roleDraft.directPermissions],
  );
  const attachedPolicyNames = useMemo(() => attachedPolicies.map((policy) => getPolicyLabel(policy)), [attachedPolicies]);

  async function loadRoles() {
    setLoadingRoles(true);
    setRoleActionError(null);

    try {
      const nextRoles = await listRoles(includeArchivedRoles);
      setRoles(nextRoles);
      setSelectedRoleId((current) => {
        if (isCreatingRole) {
          return current;
        }

        if (current && nextRoles.some((role) => role.id === current)) {
          return current;
        }

        return nextRoles[0]?.id ?? null;
      });
    } catch (error) {
      setRoleActionError(error instanceof Error ? error.message : "Unable to load roles.");
    } finally {
      setLoadingRoles(false);
    }
  }

  async function loadRoleDetail(roleId: string) {
    setLoadingRoleDetail(true);
    setRoleActionError(null);

    try {
      const role = await getRole(roleId);
      setRoleDraft(roleToDraft(role));
      setRoleValidation([]);
      setLoadedRoleId(role.id);
      setLoadedRoleArchived(role.archived);
      setIsCreatingRole(false);
    } catch (error) {
      setRoleActionError(error instanceof Error ? error.message : "Unable to load role.");
    } finally {
      setLoadingRoleDetail(false);
    }
  }

  useEffect(() => {
    void loadRoles();
  }, [includeArchivedRoles]);

  useEffect(() => {
    let cancelled = false;
    setLoadingModelOptions(true);
    void Promise.all([listPiModels(), getPiExecutableDiagnostic()])
      .then(([models, diagnostic]) => {
        if (!cancelled) {
          setAvailableModels(models);
          setPiExecutableDiagnostic(diagnostic);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRoleActionError(error instanceof Error ? error.message : String(error || "Unable to load PI models."));
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
          setRoleActionError(error instanceof Error ? error.message : "Unable to load policy definitions.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isCreatingRole) {
      return;
    }

    const roleId = selectedRoleSummary?.id;
    if (!roleId || roleId === loadedRoleId) {
      return;
    }

    void loadRoleDetail(roleId);
  }, [selectedRoleSummary?.id, isCreatingRole, loadedRoleId]);

  useEffect(() => {
    if (!selectionRequest || selectionRequest.token === selectionRequestTokenRef.current) {
      return;
    }

    selectionRequestTokenRef.current = selectionRequest.token;
    setIsCreatingRole(false);
    setSelectedRoleId(selectionRequest.roleId);
  }, [selectionRequest]);

  async function refreshRoleValidation(nextDraft: RoleUpsertInput) {
    try {
      const validation = await validateRole(nextDraft);
      setRoleValidation(validation.errors);
      return validation.errors;
    } catch (error) {
      setRoleActionError(error instanceof Error ? error.message : "Unable to validate role.");
      return [];
    }
  }

  function updateRoleDraft(updater: (draft: RoleUpsertInput) => RoleUpsertInput) {
    setRoleDraft((current) => {
      const next = updater(current);
      void refreshRoleValidation(next);
      return next;
    });
  }

  function beginCreateRole() {
    setSelectedRoleId(null);
    setRoleDraft(createBlankRoleDraft());
    setRoleValidation([]);
    setRoleActionError(null);
    setLoadedRoleId(null);
    setLoadedRoleArchived(false);
    setIsCreatingRole(true);
  }

  async function handleSaveRole() {
    setSavingRole(true);
    setRoleActionError(null);

    try {
      const validation = await validateRole(roleDraft);
      setRoleValidation(validation.errors);
      if (!validation.valid) {
        setRoleActionError("Fix the role validation errors before saving.");
        return;
      }

      const saved = loadedRoleId && !isCreatingRole ? await updateRole(loadedRoleId, roleDraft) : await createRole(roleDraft);

      await loadRoles();
      setSelectedRoleId(saved.id);
      setLoadedRoleId(saved.id);
      setLoadedRoleArchived(saved.archived);
      setRoleDraft(roleToDraft(saved));
      setRoleValidation([]);
      setIsCreatingRole(false);
    } catch (error) {
      setRoleActionError(error instanceof Error ? error.message : "Unable to save role.");
    } finally {
      setSavingRole(false);
    }
  }

  async function handleArchiveRole() {
    if (!selectedRoleSummary) {
      return;
    }

    setSavingRole(true);
    setRoleActionError(null);
    try {
      const archived = await archiveRole(selectedRoleSummary.id);
      await loadRoles();
      setSelectedRoleId(archived.id);
      await loadRoleDetail(archived.id);
    } catch (error) {
      setRoleActionError(error instanceof Error ? error.message : "Unable to archive role.");
    } finally {
      setSavingRole(false);
    }
  }

  return (
    <section className="role-shell">
      <aside className="role-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Role library</p>
            <h3>Roles</h3>
          </div>
          <div className="action-cluster">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeArchivedRoles}
                onChange={(event) => setIncludeArchivedRoles(event.target.checked)}
              />
              Show archived
            </label>
            <button className="primary-button" data-role="new-role" type="button" onClick={beginCreateRole}>
              New role
            </button>
          </div>
        </div>

        {loadingRoles ? <p className="muted-copy">Loading roles…</p> : null}
        {roleActionError ? <p className="error-copy">{roleActionError}</p> : null}

        <nav className="role-list" aria-label="Roles">
          {roles.map((role) => (
            <a
              key={role.id}
              className={role.id === selectedRoleSummary?.id && !isCreatingRole ? "role-list-link role-list-link--active" : "role-list-link"}
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setSelectedRoleId(role.id);
              }}
            >
              {role.name}
              <span className="role-list-link__meta">{role.thinkingLevel}</span>
            </a>
          ))}
        </nav>
      </aside>

      <section className="panel role-detail-panel">
        {selectedRoleSummary || isCreatingRole ? (
          <div className="workflow-editor-grid">
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Role definition</p>
                <h3>{isCreatingRole ? "Create role" : roleDraft.name.trim() || "Untitled role"}</h3>
              </div>
              <div className="action-cluster">
                {loadedRoleArchived ? <span className="status-badge status-badge--neutral">Archived</span> : null}
                {attachedPolicyNames.map((name) => (
                  <span className="status-badge status-badge--accent" key={name}>
                    {name}
                  </span>
                ))}
                {!isCreatingRole && loadedRoleId ? (
                  <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleArchiveRole()} disabled={savingRole || loadedRoleArchived}>
                    Archive role
                  </button>
                ) : null}
                <button className="primary-button" data-role="save-role" type="button" onClick={() => void handleSaveRole()} disabled={savingRole || loadingRoleDetail}>
                  {savingRole ? "Saving…" : isCreatingRole ? "Create role" : "Save changes"}
                </button>
              </div>
            </div>

            {loadingRoleDetail ? <p className="muted-copy">Loading role…</p> : null}

            <section className="workflow-section">
              <div>
                <p className="eyebrow">Execution defaults</p>
                <h3>Configuration</h3>
              </div>

              <div className="workflow-form-grid">
                <label className="field-group">
                  <span className="field-group__label">Role name</span>
                  <input
                    className="text-input"
                    data-role="role-name"
                    type="text"
                    value={roleDraft.name}
                    onChange={(event) => updateRoleDraft((draft) => ({ ...draft, name: event.target.value }))}
                  />
                  {getRoleValidationForPath(roleValidation, "name").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Capacity</span>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    step={1}
                    value={roleDraft.capacity}
                    onChange={(event) =>
                      updateRoleDraft((draft) => ({
                        ...draft,
                        capacity: Number.parseInt(event.target.value, 10) || 0,
                      }))
                    }
                  />
                  {getRoleValidationForPath(roleValidation, "capacity").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Provider</span>
                  <select
                    className="select-input"
                    value={roleDraft.provider ?? ""}
                    disabled={loadingModelOptions}
                    onChange={(event) =>
                      updateRoleDraft((draft) => ({
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
                  {getRoleValidationForPath(roleValidation, "provider").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Model</span>
                  <select
                    className="select-input"
                    value={roleDraft.model ?? ""}
                    disabled={loadingModelOptions || !(roleDraft.provider ?? "")}
                    onChange={(event) => updateRoleDraft((draft) => ({ ...draft, model: event.target.value }))}
                  >
                    <option value="">
                      {loadingModelOptions ? "Loading models…" : roleDraft.provider ? "Select a model" : "Select a provider first"}
                    </option>
                    {filteredModelOptions.map((model) => (
                      <option key={`${model.provider}/${model.id}`} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  {getRoleValidationForPath(roleValidation, "model").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Thinking</span>
                  <select
                    className="select-input"
                    value={roleDraft.thinkingLevel ?? "off"}
                    onChange={(event) => updateRoleDraft((draft) => ({ ...draft, thinkingLevel: event.target.value }))}
                  >
                    <option value="off">Off</option>
                    <option value="minimal">Minimal</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                  </select>
                  {getRoleValidationForPath(roleValidation, "thinkingLevel").map((error) => (
                    <span className="field-error" key={error.message}>{error.message}</span>
                  ))}
                </label>

                <div className="workflow-form-grid__full muted-copy" data-role="role-pi-executable-diagnostic">
                  PI executable: {piExecutableDiagnostic?.resolvedPath ?? piExecutableDiagnostic?.error ?? "Loading…"}
                </div>

                <label className="field-group workflow-form-grid__full">
                  <span className="field-group__label">Description</span>
                  <textarea
                    className="text-area"
                    rows={3}
                    value={roleDraft.description ?? ""}
                    onChange={(event) => updateRoleDraft((draft) => ({ ...draft, description: event.target.value }))}
                  />
                </label>

                <label className="field-group workflow-form-grid__full">
                  <span className="field-group__label">System prompt</span>
                  <textarea
                    className="text-area"
                    rows={8}
                    value={roleDraft.systemPrompt ?? ""}
                    onChange={(event) => updateRoleDraft((draft) => ({ ...draft, systemPrompt: event.target.value }))}
                  />
                </label>
              </div>
            </section>

            <AccessEditor
              actorLabel="role"
              dataRolePrefix="role"
              policyIds={roleDraft.policyIds ?? []}
              directPermissions={roleDraft.directPermissions ?? []}
              attachedPolicies={attachedPolicies}
              effectivePermissions={effectiveAccess.permissions}
              grantsFullAccess={effectiveAccess.grantsFullAccess}
              onPolicyIdsChange={(policyIds) => updateRoleDraft((draft) => ({ ...draft, policyIds }))}
              onDirectPermissionsChange={(directPermissions) => updateRoleDraft((draft) => ({ ...draft, directPermissions }))}
            />

            <p className="muted-copy">Permissions assigned here are inherited by role instances spawned from this role.</p>

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
            <p className="eyebrow">No role selected</p>
            <h3>Create or select a role</h3>
            <p>Use the role list to inspect an existing definition or create a new role for workflow ownership.</p>
          </div>
        )}
      </section>
    </section>
  );
}
