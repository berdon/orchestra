import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PiPanel } from "./PiPanel";
import type {
  HarnessModelLimitPolicy,
  HarnessModelLimitState,
  HarnessModelLimitsSnapshot,
  HarnessModelRef,
  PiRuntimeDiagnostics,
  PiRuntimeSettings,
  SessionModel,
} from "../types";

type HarnessPanelProps = Omit<ComponentProps<typeof PiPanel>, "mode"> & {
  harnessModelLimitsSnapshot: HarnessModelLimitsSnapshot | null;
  piRuntimeSettings: PiRuntimeSettings | null;
  piRuntimeDiagnostics: PiRuntimeDiagnostics | null;
  onSavePiRuntimeSettings: (input: { extraExtensions: string[]; defaultCompactionWindow: string }) => void;
  onSaveHarnessModelLimitPolicy: (input: {
    modelRef: { provider: string; modelId: string; api?: string | null };
    rolling5hPercent?: number | null;
    weeklyPercent?: number | null;
  }) => Promise<void> | void;
  onImportLegacyPiConfiguration: (input: { importAuth: boolean; importModels: boolean }) => void;
};

type HarnessSection = "general" | "models";
type PolicyRowDraft = {
  id: string;
  persisted: boolean;
  persistedModelRef: HarnessModelRef | null;
  provider: string;
  modelId: string;
  api: string;
  rolling5hPercent: string;
  weeklyPercent: string;
};
type ModelOption = { value: string; label: string; model: SessionModel };

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

function modelRefKey(model: Pick<HarnessModelRef, "provider" | "modelId" | "api">) {
  return `${model.provider}::${model.modelId}::${model.api ?? ""}`;
}

function modelKey(model: Pick<SessionModel, "provider" | "id" | "api">) {
  return modelRefKey({ provider: model.provider, modelId: model.id, api: model.api });
}

function sameModelRef(left: Pick<HarnessModelRef, "provider" | "modelId" | "api">, right: Pick<HarnessModelRef, "provider" | "modelId" | "api">) {
  return left.provider === right.provider
    && left.modelId === right.modelId
    && (left.api ?? null) === (right.api ?? null);
}

function findPolicy(policies: HarnessModelLimitPolicy[], modelRef: Pick<HarnessModelRef, "provider" | "modelId" | "api">) {
  return policies.find((policy) => sameModelRef(policy.modelRef, modelRef)) ?? null;
}

function findState(states: HarnessModelLimitState[], modelRef: Pick<HarnessModelRef, "provider" | "modelId" | "api">) {
  return states.find((state) => sameModelRef(state.modelRef, modelRef)) ?? null;
}

function findAvailableModel(models: SessionModel[], modelRef: Pick<HarnessModelRef, "provider" | "modelId" | "api">) {
  return models.find((model) => sameModelRef({ provider: model.provider, modelId: model.id, api: model.api }, modelRef)) ?? null;
}

function ruleValue(policy: HarnessModelLimitPolicy | null, metricKey: string) {
  return policy?.rules.find((rule) => rule.metricKey === metricKey)?.thresholdValue ?? null;
}

function metricValue(state: HarnessModelLimitState | null, metricKey: string) {
  return state?.metrics.find((metric) => metric.metricKey === metricKey) ?? null;
}

function validatePercentDraft(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return `${label} must be a whole-number percent.`;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > 100) {
    return `${label} must be between 1 and 100.`;
  }
  return null;
}

function parsePercentDraft(value: string) {
  const trimmed = value.trim();
  return trimmed ? Number.parseInt(trimmed, 10) : null;
}

function createPersistedPolicyRows(snapshot: HarnessModelLimitsSnapshot | null) {
  return (snapshot?.policies ?? []).map((policy) => ({
    id: `persisted-${modelRefKey(policy.modelRef)}`,
    persisted: true,
    persistedModelRef: policy.modelRef,
    provider: policy.modelRef.provider,
    modelId: policy.modelRef.modelId,
    api: policy.modelRef.api ?? "",
    rolling5hPercent: ruleValue(policy, "rolling_5h_percent")?.toString() ?? "",
    weeklyPercent: ruleValue(policy, "weekly_percent")?.toString() ?? "",
  } satisfies PolicyRowDraft));
}

function createEmptyPolicyRow(id: string): PolicyRowDraft {
  return {
    id,
    persisted: false,
    persistedModelRef: null,
    provider: "",
    modelId: "",
    api: "",
    rolling5hPercent: "",
    weeklyPercent: "",
  };
}

function rowModelRef(row: Pick<PolicyRowDraft, "provider" | "modelId" | "api">): HarnessModelRef | null {
  if (!row.provider || !row.modelId) {
    return null;
  }
  return {
    provider: row.provider,
    modelId: row.modelId,
    api: row.api || null,
  };
}

function modelOptionLabel(model: SessionModel) {
  return `${model.name} (${model.id}${model.api ? ` · ${model.api}` : ""})`;
}

function hasAnyLimit(row: Pick<PolicyRowDraft, "rolling5hPercent" | "weeklyPercent">) {
  return Boolean(row.rolling5hPercent.trim() || row.weeklyPercent.trim());
}

function statusTone(state: HarnessModelLimitState | null, hasPolicy: boolean) {
  if (state?.capped) {
    return "status-badge--error";
  }
  if (state?.usageSource.adapter === "unsupported") {
    return "status-badge--warning";
  }
  if (hasPolicy) {
    return "status-badge--success";
  }
  return "status-badge--neutral";
}

function statusLabel(state: HarnessModelLimitState | null, hasPolicy: boolean) {
  if (state?.capped) {
    return "Paused by cap";
  }
  if (state?.usageSource.adapter === "unsupported") {
    return "Unsupported";
  }
  if (hasPolicy) {
    return "Policy configured";
  }
  return "Draft";
}

export function HarnessPanel({
  harnessModelLimitsSnapshot,
  piRuntimeSettings,
  piRuntimeDiagnostics,
  onSavePiRuntimeSettings,
  onSaveHarnessModelLimitPolicy,
  onImportLegacyPiConfiguration,
  ...piPanelProps
}: HarnessPanelProps) {
  const packageDiagnostics = piPanelProps.piSetupState?.packageDiagnostics ?? null;
  const availableModels = piPanelProps.piSetupState?.availableModels ?? [];
  const [selectedSection, setSelectedSection] = useState<HarnessSection>("general");
  const [piExtensionsDraft, setPiExtensionsDraft] = useState("");
  const [defaultCompactionWindowDraft, setDefaultCompactionWindowDraft] = useState("10%");
  const [policyRows, setPolicyRows] = useState<PolicyRowDraft[]>([]);
  const [savingRowIds, setSavingRowIds] = useState<Record<string, boolean>>({});
  const nextPolicyRowIdRef = useRef(1);

  useEffect(() => {
    setPiExtensionsDraft(piRuntimeSettings?.extraExtensions.join("\n") ?? "");
    setDefaultCompactionWindowDraft(piRuntimeSettings?.defaultCompactionWindow ?? "10%");
  }, [piRuntimeSettings?.defaultCompactionWindow, piRuntimeSettings?.extraExtensions]);

  useEffect(() => {
    const persistedRows = createPersistedPolicyRows(harnessModelLimitsSnapshot);
    const persistedKeys = new Set(persistedRows.map((row) => modelRefKey(row.persistedModelRef ?? { provider: row.provider, modelId: row.modelId, api: row.api }))); 
    setPolicyRows((current) => {
      const unsavedRows = current.filter((row) => !row.persisted && !persistedKeys.has(modelRefKey({ provider: row.provider, modelId: row.modelId, api: row.api })));
      return [...persistedRows, ...unsavedRows];
    });
  }, [harnessModelLimitsSnapshot]);

  const updatePolicyRow = (rowId: string, partial: Partial<PolicyRowDraft>) => {
    setPolicyRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...partial } : row)));
  };

  const policies = harnessModelLimitsSnapshot?.policies ?? [];
  const states = harnessModelLimitsSnapshot?.states ?? [];
  const configuredPolicyCount = policies.length;
  const cappedCount = states.filter((state) => state.capped).length;
  const unsupportedCount = states.filter((state) => state.usageSource.adapter === "unsupported").length;

  const providerOptions = useMemo(() => Array.from(new Set([
    ...availableModels.map((model) => model.provider),
    ...policyRows.map((row) => row.provider).filter(Boolean),
    ...policies.map((policy) => policy.modelRef.provider),
  ])).sort((left, right) => left.localeCompare(right)), [availableModels, policies, policyRows]);

  const getModelOptions = (row: PolicyRowDraft): ModelOption[] => {
    if (!row.provider) {
      return [];
    }
    const options = availableModels
      .filter((model) => model.provider === row.provider)
      .map((model) => ({
        value: modelKey(model),
        label: modelOptionLabel(model),
        model,
      }));

    const currentRef = rowModelRef(row);
    if (currentRef) {
      const existingMatch = options.some((option) => sameModelRef({ provider: option.model.provider, modelId: option.model.id, api: option.model.api }, currentRef));
      if (!existingMatch) {
        options.push({
          value: modelRefKey(currentRef),
          label: `${currentRef.modelId}${currentRef.api ? ` · ${currentRef.api}` : ""} (configured, currently unavailable)`,
          model: {
            id: currentRef.modelId,
            name: currentRef.modelId,
            provider: currentRef.provider,
            api: currentRef.api ?? "",
            reasoning: false,
          },
        });
      }
    }

    return options.sort((left, right) => left.label.localeCompare(right.label));
  };

  const addPolicyRow = () => {
    setPolicyRows((current) => [...current, createEmptyPolicyRow(`draft-${nextPolicyRowIdRef.current++}`)]);
  };

  const savePolicyRow = async (row: PolicyRowDraft) => {
    const modelRef = rowModelRef(row);
    if (!modelRef) {
      return;
    }

    const previousModelRef = row.persistedModelRef;
    const rolling5hPercent = parsePercentDraft(row.rolling5hPercent);
    const weeklyPercent = parsePercentDraft(row.weeklyPercent);

    setSavingRowIds((current) => ({ ...current, [row.id]: true }));
    try {
      if (previousModelRef && !sameModelRef(previousModelRef, modelRef)) {
        await Promise.resolve(onSaveHarnessModelLimitPolicy({
          modelRef: previousModelRef,
          rolling5hPercent: null,
          weeklyPercent: null,
        }));
      }
      await Promise.resolve(onSaveHarnessModelLimitPolicy({
        modelRef,
        rolling5hPercent,
        weeklyPercent,
      }));
    } finally {
      setSavingRowIds((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    }
  };

  const removePolicyRow = async (row: PolicyRowDraft) => {
    const modelRef = row.persistedModelRef ?? rowModelRef(row);
    if (!modelRef || !row.persistedModelRef) {
      setPolicyRows((current) => current.filter((entry) => entry.id !== row.id));
      return;
    }

    setSavingRowIds((current) => ({ ...current, [row.id]: true }));
    try {
      await Promise.resolve(onSaveHarnessModelLimitPolicy({
        modelRef,
        rolling5hPercent: null,
        weeklyPercent: null,
      }));
    } finally {
      setSavingRowIds((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    }
  };

  const generalDetail = (
    <div className="task-detail-stack">
      <section className="task-section task-section--compact" data-role="pi-runtime-settings-panel">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Harness configuration</p>
            <h3>Harness settings</h3>
            <p className="supporting-copy">Extra extensions apply to new harness sessions only. Existing sessions keep their current extension set.</p>
          </div>
          <div className="action-cluster action-cluster--wrap">
            <button
              className="secondary-button"
              data-role="reset-pi-runtime-extensions"
              type="button"
              onClick={() => {
                setPiExtensionsDraft("");
                setDefaultCompactionWindowDraft("10%");
              }}
            >
              Reset to built-in defaults
            </button>
            <button
              className="secondary-button"
              data-role="save-pi-runtime-extensions"
              type="button"
              onClick={() => onSavePiRuntimeSettings({
                extraExtensions: piExtensionsDraft.split(/\r?\n/g),
                defaultCompactionWindow: defaultCompactionWindowDraft,
              })}
            >
              Save Harness settings
            </button>
          </div>
        </div>
        {piRuntimeDiagnostics ? (
          <div className="field-group field-group--compact" data-role="pi-runtime-diagnostics-summary">
            <span className="field-group__label">Runtime diagnostics</span>
            <span className="field-group__hint">Runtime: {piRuntimeDiagnostics.runtime.message}</span>
            <span className="field-group__hint">Auth: {piRuntimeDiagnostics.auth.message}</span>
            <span className="field-group__hint">Agent dir: {piRuntimeDiagnostics.auth.agentDir}</span>
            <span className="field-group__hint">Settings file: {piRuntimeDiagnostics.auth.settingsPath}</span>
            {piRuntimeDiagnostics.addOns.blockedExtensions.length ? (
              <span className="field-error">Blocked packaged-mode add-ons: {piRuntimeDiagnostics.addOns.blockedExtensions.join(", ")}</span>
            ) : (
              <span className="field-group__hint">Add-on policy: {piRuntimeDiagnostics.addOns.message}</span>
            )}
            {piRuntimeDiagnostics.auth.legacyAuthAvailable || piRuntimeDiagnostics.auth.legacyModelsAvailable ? (
              <div className="action-cluster action-cluster--wrap">
                {piRuntimeDiagnostics.auth.legacyAuthAvailable ? (
                  <button
                    className="secondary-button"
                    data-role="import-legacy-pi-auth"
                    type="button"
                    onClick={() => onImportLegacyPiConfiguration({ importAuth: true, importModels: false })}
                  >
                    Import legacy auth.json
                  </button>
                ) : null}
                {piRuntimeDiagnostics.auth.legacyModelsAvailable ? (
                  <button
                    className="secondary-button"
                    data-role="import-legacy-pi-models"
                    type="button"
                    onClick={() => onImportLegacyPiConfiguration({ importAuth: false, importModels: true })}
                  >
                    Import legacy models.json
                  </button>
                ) : null}
                {piRuntimeDiagnostics.auth.legacyAuthAvailable && piRuntimeDiagnostics.auth.legacyModelsAvailable ? (
                  <button
                    className="secondary-button"
                    data-role="import-legacy-pi-auth-and-models"
                    type="button"
                    onClick={() => onImportLegacyPiConfiguration({ importAuth: true, importModels: true })}
                  >
                    Import both
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {packageDiagnostics ? (
          <div className="field-group field-group--compact" data-role="pi-package-diagnostics-summary">
            <span className="field-group__label">Package source + Bun status</span>
            <span className={packageDiagnostics.bun.available ? "field-group__hint" : "field-error"}>
              Bun: {packageDiagnostics.bun.message}
            </span>
            <span className="field-group__hint">Status: {packageDiagnostics.message}</span>
            {packageDiagnostics.sources.length ? (
              <div className="workflow-validation-list muted-copy">
                {packageDiagnostics.sources.map((source) => (
                  <p key={`${source.sourceKind}-${source.sourcePath}`}>
                    {source.active ? "Active" : "Legacy"} {source.sourcePath}: {source.entries.join(", ")}
                  </p>
                ))}
              </div>
            ) : (
              <span className="field-group__hint">No package-based Pi sources are currently detected.</span>
            )}
          </div>
        ) : null}
        <label className="field-group field-group--compact">
          <span className="field-group__label">Default compaction window</span>
          <input
            className="text-input"
            data-role="pi-runtime-default-compaction-window"
            type="text"
            placeholder="10%"
            value={defaultCompactionWindowDraft}
            onChange={(event) => setDefaultCompactionWindowDraft(event.target.value)}
          />
          <span className="field-group__hint">Use `10%`, a token reserve like `16000`, or `off` to disable Orchestra-managed auto-compaction by default.</span>
        </label>
        <label className="field-group">
          <span className="field-group__label">Extra runtime extensions</span>
          <textarea
            className="text-area"
            data-role="pi-runtime-extensions"
            rows={6}
            placeholder="./extensions/local-extension.ts\n~/pi-extensions/custom/index.ts"
            value={piExtensionsDraft}
            onChange={(event) => setPiExtensionsDraft(event.target.value)}
          />
        </label>
        <p className="muted-copy">Last updated: {formatDateTime(piRuntimeSettings?.updatedAt)}</p>
      </section>

      <PiPanel mode="setup" {...piPanelProps} />
    </div>
  );

  const modelsDetail = (
    <div className="task-detail-stack">
      <section className="task-section task-section--compact" data-role="harness-model-limits-panel">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Harness models</p>
            <h3>Structured model policies</h3>
            <p className="supporting-copy">Start with an empty table, add the provider/model rows you want to govern, and set 5-hour and/or weekly pause thresholds for each one.</p>
          </div>
          <div className="action-cluster action-cluster--wrap">
            <button
              className="secondary-button"
              data-role="add-harness-model-policy-row"
              type="button"
              disabled={providerOptions.length === 0}
              onClick={addPolicyRow}
            >
              Add limit row
            </button>
          </div>
        </div>
        <div className="workflow-validation-list muted-copy">
          <p>Configured models in Pi: {availableModels.length}</p>
          <p>Models with saved policies: {configuredPolicyCount}</p>
          <p>Capped right now: {cappedCount}</p>
          <p>Unsupported usage adapters: {unsupportedCount}</p>
        </div>
        <div className="task-table-wrap">
          <table className="task-table" data-role="harness-model-policy-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>5-hour limit (%)</th>
                <th>Weekly limit (%)</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policyRows.length ? policyRows.map((row, index) => {
                const modelRef = rowModelRef(row);
                const rowPolicy = modelRef ? findPolicy(policies, modelRef) : null;
                const state = modelRef ? findState(states, modelRef) : null;
                const rollingError = validatePercentDraft(row.rolling5hPercent, "5-hour limit");
                const weeklyError = validatePercentDraft(row.weeklyPercent, "Weekly limit");
                const selectionError = !row.provider || !row.modelId ? "Choose a provider and model." : null;
                const duplicateError = modelRef && policyRows.some((otherRow) => otherRow.id !== row.id && rowModelRef(otherRow) && sameModelRef(rowModelRef(otherRow)!, modelRef))
                  ? "This model already has a row."
                  : null;
                const missingLimitError = !hasAnyLimit(row) ? "Enter at least one limit to save this row." : null;
                const saveDisabled = Boolean(selectionError || duplicateError || missingLimitError || rollingError || weeklyError || savingRowIds[row.id]);
                const fiveHourMetric = metricValue(state, "rolling_5h_percent");
                const weeklyMetric = metricValue(state, "weekly_percent");
                const modelOptions = getModelOptions(row);
                const selectedModelValue = modelRef ? modelRefKey(modelRef) : "";
                const availabilityLabel = modelRef && !findAvailableModel(availableModels, modelRef)
                  ? "Configured model not currently available in Pi."
                  : null;

                return (
                  <tr key={row.id} data-role={`harness-model-policy-row-${index}`}>
                    <td>
                      <label className="field-group field-group--compact">
                        <span className="sr-only">Provider</span>
                        <select
                          className="text-input"
                          data-role={`harness-model-provider-${index}`}
                          value={row.provider}
                          onChange={(event) => updatePolicyRow(row.id, {
                            provider: event.target.value,
                            modelId: "",
                            api: "",
                          })}
                        >
                          <option value="">Select provider</option>
                          {providerOptions.map((provider) => (
                            <option key={provider} value={provider}>{provider}</option>
                          ))}
                        </select>
                      </label>
                    </td>
                    <td>
                      <label className="field-group field-group--compact">
                        <span className="sr-only">Model</span>
                        <select
                          className="text-input"
                          data-role={`harness-model-select-${index}`}
                          value={selectedModelValue}
                          disabled={!row.provider}
                          onChange={(event) => {
                            const selectedOption = modelOptions.find((option) => option.value === event.target.value);
                            if (!selectedOption) {
                              updatePolicyRow(row.id, { modelId: "", api: "" });
                              return;
                            }
                            updatePolicyRow(row.id, {
                              provider: selectedOption.model.provider,
                              modelId: selectedOption.model.id,
                              api: selectedOption.model.api,
                            });
                          }}
                        >
                          <option value="">{row.provider ? "Select model" : "Choose provider first"}</option>
                          {modelOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      {availabilityLabel ? <p className="muted-copy">{availabilityLabel}</p> : null}
                    </td>
                    <td>
                      <label className="field-group field-group--compact">
                        <span className="sr-only">5-hour limit</span>
                        <input
                          className="text-input"
                          data-role={`harness-model-rolling-5h-${index}`}
                          inputMode="numeric"
                          type="text"
                          placeholder="90"
                          value={row.rolling5hPercent}
                          onChange={(event) => updatePolicyRow(row.id, { rolling5hPercent: event.target.value })}
                        />
                        {rollingError ? <span className="field-error">{rollingError}</span> : <span className="field-group__hint">Pause at or above this rolling 5-hour percentage.</span>}
                      </label>
                    </td>
                    <td>
                      <label className="field-group field-group--compact">
                        <span className="sr-only">Weekly limit</span>
                        <input
                          className="text-input"
                          data-role={`harness-model-weekly-${index}`}
                          inputMode="numeric"
                          type="text"
                          placeholder="80"
                          value={row.weeklyPercent}
                          onChange={(event) => updatePolicyRow(row.id, { weeklyPercent: event.target.value })}
                        />
                        {weeklyError ? <span className="field-error">{weeklyError}</span> : <span className="field-group__hint">Pause at or above this weekly percentage.</span>}
                      </label>
                    </td>
                    <td>
                      <div className="task-section-list">
                        <span className={`status-badge ${statusTone(state, Boolean(rowPolicy || row.persistedModelRef))}`}>
                          {statusLabel(state, Boolean(rowPolicy || row.persistedModelRef))}
                        </span>
                        <div className="muted-copy">
                          <div>5h usage: {fiveHourMetric ? `${fiveHourMetric.value}%` : "—"}</div>
                          <div>Weekly usage: {weeklyMetric ? `${weeklyMetric.value}%` : "—"}</div>
                          <div>Last checked: {formatDateTime(state?.lastCheckedAt)}</div>
                          {state?.reason ? <div>{state.reason}</div> : null}
                          {state?.lastError ? <div className="error-copy">{state.lastError}</div> : null}
                          {selectionError ? <div className="field-error">{selectionError}</div> : null}
                          {duplicateError ? <div className="field-error">{duplicateError}</div> : null}
                          {!selectionError && !duplicateError && missingLimitError ? <div className="field-error">{missingLimitError}</div> : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="action-cluster action-cluster--wrap">
                        <button
                          className="secondary-button"
                          data-role={`save-harness-model-policy-${index}`}
                          disabled={saveDisabled}
                          type="button"
                          onClick={() => void savePolicyRow(row)}
                        >
                          {savingRowIds[row.id] ? "Saving…" : "Save"}
                        </button>
                        <button
                          className="secondary-button"
                          data-role={`remove-harness-model-policy-${index}`}
                          disabled={Boolean(savingRowIds[row.id])}
                          type="button"
                          onClick={() => void removePolicyRow(row)}
                        >
                          Remove row
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr data-role="harness-model-policy-empty-row">
                  <td colSpan={6}>
                    <p className="muted-copy" data-role="harness-model-policy-empty">
                      {providerOptions.length
                        ? "No model limit rows yet. Add a row to choose a provider/model and set limits."
                        : "No configured models are currently available. Connect a provider or import a Pi setup in General before adding model-limit policies."}
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <PiPanel mode="models" {...piPanelProps} />
    </div>
  );

  return (
    <section className="panel task-detail-tabs-panel">
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Settings</p>
          <h3>Harness</h3>
          <p className="muted-copy">Manage Orchestra-owned runtime, provider auth, and model-governance settings.</p>
        </div>
      </div>
      <div className="task-detail-tab-dock">
        <div className="task-detail-tabs task-detail-tabs--dock" role="tablist" aria-label="Harness sections">
          <button
            className={selectedSection === "general" ? "task-detail-tab task-detail-tab--active" : "task-detail-tab"}
            data-role="harness-subnav-general"
            role="tab"
            aria-selected={selectedSection === "general"}
            type="button"
            onClick={() => setSelectedSection("general")}
          >
            General
          </button>
          <button
            className={selectedSection === "models" ? "task-detail-tab task-detail-tab--active" : "task-detail-tab"}
            data-role="harness-subnav-models"
            role="tab"
            aria-selected={selectedSection === "models"}
            type="button"
            onClick={() => setSelectedSection("models")}
          >
            Models
          </button>
        </div>
      </div>
      <div className="task-detail-tabs__body">
        {selectedSection === "general" ? generalDetail : modelsDetail}
      </div>
    </section>
  );
}
