import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PiPanel } from "./PiPanel";
import type {
  HarnessModelLimitPolicy,
  HarnessModelLimitState,
  HarnessModelLimitsSnapshot,
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
  }) => void;
  onImportLegacyPiConfiguration: (input: { importAuth: boolean; importModels: boolean }) => void;
};

type HarnessSection = "general" | "models";
type ModelDraft = { rolling5hPercent: string; weeklyPercent: string };

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

function sanitizeKey(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function modelKey(model: Pick<SessionModel, "provider" | "id" | "api">) {
  return `${model.provider}::${model.id}::${model.api}`;
}

function findPolicy(policies: HarnessModelLimitPolicy[], model: SessionModel) {
  return policies.find(
    (policy) => policy.modelRef.provider === model.provider
      && policy.modelRef.modelId === model.id
      && (policy.modelRef.api ?? null) === (model.api ?? null),
  ) ?? null;
}

function findState(states: HarnessModelLimitState[], model: SessionModel) {
  return states.find(
    (state) => state.modelRef.provider === model.provider
      && state.modelRef.modelId === model.id
      && (state.modelRef.api ?? null) === (model.api ?? null),
  ) ?? null;
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

function createDrafts(models: SessionModel[], snapshot: HarnessModelLimitsSnapshot | null) {
  const policies = snapshot?.policies ?? [];
  return Object.fromEntries(models.map((model) => {
    const policy = findPolicy(policies, model);
    return [modelKey(model), {
      rolling5hPercent: ruleValue(policy, "rolling_5h_percent")?.toString() ?? "",
      weeklyPercent: ruleValue(policy, "weekly_percent")?.toString() ?? "",
    } satisfies ModelDraft];
  }));
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
  const [modelDrafts, setModelDrafts] = useState<Record<string, ModelDraft>>({});
  const modelDraftsRef = useRef<Record<string, ModelDraft>>({});

  useEffect(() => {
    setPiExtensionsDraft(piRuntimeSettings?.extraExtensions.join("\n") ?? "");
    setDefaultCompactionWindowDraft(piRuntimeSettings?.defaultCompactionWindow ?? "10%");
  }, [piRuntimeSettings?.defaultCompactionWindow, piRuntimeSettings?.extraExtensions]);

  useEffect(() => {
    const nextDrafts = createDrafts(availableModels, harnessModelLimitsSnapshot);
    modelDraftsRef.current = nextDrafts;
    setModelDrafts(nextDrafts);
  }, [availableModels, harnessModelLimitsSnapshot]);

  const updateModelDraft = (key: string, partial: Partial<ModelDraft>) => {
    setModelDrafts((current) => {
      const nextDraft = {
        rolling5hPercent: current[key]?.rolling5hPercent ?? "",
        weeklyPercent: current[key]?.weeklyPercent ?? "",
        ...partial,
      } satisfies ModelDraft;
      const nextDrafts = {
        ...current,
        [key]: nextDraft,
      };
      modelDraftsRef.current = nextDrafts;
      return nextDrafts;
    });
  };

  const policies = harnessModelLimitsSnapshot?.policies ?? [];
  const states = harnessModelLimitsSnapshot?.states ?? [];
  const configuredPolicyCount = policies.length;
  const cappedCount = states.filter((state) => state.capped).length;
  const unsupportedCount = states.filter((state) => state.usageSource.adapter === "unsupported").length;

  const modelCards = useMemo(() => availableModels.map((model) => {
    const key = modelKey(model);
    const policy = findPolicy(policies, model);
    const state = findState(states, model);
    const draft = modelDrafts[key] ?? { rolling5hPercent: "", weeklyPercent: "" };
    return { key, model, policy, state, draft };
  }), [availableModels, modelDrafts, policies, states]);

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
            <h3>Models</h3>
            <p className="supporting-copy">Pause sessions and lanes when configured provider/model usage crosses your threshold. Policies are stored in Orchestra-owned Harness settings, while raw <code>models.json</code> remains available below for advanced provider config.</p>
          </div>
        </div>
        <div className="workflow-validation-list muted-copy">
          <p>Configured models: {availableModels.length}</p>
          <p>Models with policies: {configuredPolicyCount}</p>
          <p>Capped right now: {cappedCount}</p>
          <p>Unsupported usage adapters: {unsupportedCount}</p>
        </div>
      </section>

      {modelCards.length ? (
        <div className="task-section-list">
          {modelCards.map(({ key, model, policy, state, draft }) => {
            const rollingError = validatePercentDraft(draft.rolling5hPercent, "5-hour limit");
            const weeklyError = validatePercentDraft(draft.weeklyPercent, "Weekly limit");
            const saveDisabled = Boolean(rollingError || weeklyError);
            const fiveHourMetric = metricValue(state, "rolling_5h_percent");
            const weeklyMetric = metricValue(state, "weekly_percent");
            return (
              <section className="task-section task-section--compact" key={key} data-role={`harness-model-policy-${sanitizeKey(key)}`}>
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">{model.provider}</p>
                    <h4>{model.name}</h4>
                    <p className="muted-copy">{model.id} · API: {model.api}</p>
                  </div>
                  <span className={`status-badge ${state?.capped ? "status-badge--error" : "status-badge--success"}`}>
                    {state?.capped ? "Paused by cap" : policy ? "Policy configured" : "No policy"}
                  </span>
                </div>

                <div className="task-section-list">
                  <label className="field-group field-group--compact">
                    <span className="field-group__label">5-hour pause threshold (%)</span>
                    <input
                      className="text-input"
                      data-role={`harness-model-rolling-5h-${sanitizeKey(key)}`}
                      inputMode="numeric"
                      type="text"
                      placeholder="90"
                      value={draft.rolling5hPercent}
                      onChange={(event) => updateModelDraft(key, { rolling5hPercent: event.target.value })}
                    />
                    <span className="field-group__hint">Pause when the provider reports the rolling 5-hour bucket at or above this percentage.</span>
                    {rollingError ? <span className="field-error">{rollingError}</span> : null}
                  </label>

                  <label className="field-group field-group--compact">
                    <span className="field-group__label">Weekly pause threshold (%)</span>
                    <input
                      className="text-input"
                      data-role={`harness-model-weekly-${sanitizeKey(key)}`}
                      inputMode="numeric"
                      type="text"
                      placeholder="80"
                      value={draft.weeklyPercent}
                      onChange={(event) => updateModelDraft(key, { weeklyPercent: event.target.value })}
                    />
                    <span className="field-group__hint">Pause when the provider reports the weekly usage bucket at or above this percentage.</span>
                    {weeklyError ? <span className="field-error">{weeklyError}</span> : null}
                  </label>
                </div>

                <div className="workflow-validation-list muted-copy">
                  <p>Current 5-hour usage: {fiveHourMetric ? `${fiveHourMetric.value}%` : "—"}</p>
                  <p>Current weekly usage: {weeklyMetric ? `${weeklyMetric.value}%` : "—"}</p>
                  <p>Last checked: {formatDateTime(state?.lastCheckedAt)}</p>
                  <p>5-hour reset: {formatDateTime(fiveHourMetric?.nextResetAt)}</p>
                  <p>Weekly reset: {formatDateTime(weeklyMetric?.nextResetAt)}</p>
                  {state?.reason ? <p>{state.reason}</p> : null}
                  {state?.lastError ? <p className="error-copy">{state.lastError}</p> : null}
                </div>

                <div className="action-cluster action-cluster--wrap">
                  <button
                    className="secondary-button"
                    data-role={`save-harness-model-policy-${sanitizeKey(key)}`}
                    disabled={saveDisabled}
                    type="button"
                    onClick={() => {
                      const currentDraft = modelDraftsRef.current[key] ?? draft;
                      onSaveHarnessModelLimitPolicy({
                        modelRef: { provider: model.provider, modelId: model.id, api: model.api },
                        rolling5hPercent: parsePercentDraft(currentDraft.rolling5hPercent),
                        weeklyPercent: parsePercentDraft(currentDraft.weeklyPercent),
                      });
                    }}
                  >
                    Save limits
                  </button>
                  <button
                    className="secondary-button"
                    data-role={`disable-harness-model-policy-${sanitizeKey(key)}`}
                    type="button"
                    onClick={() => {
                      updateModelDraft(key, { rolling5hPercent: "", weeklyPercent: "" });
                      onSaveHarnessModelLimitPolicy({
                        modelRef: { provider: model.provider, modelId: model.id, api: model.api },
                        rolling5hPercent: null,
                        weeklyPercent: null,
                      });
                    }}
                  >
                    Disable limits
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="task-section task-section--compact">
          <p className="muted-copy">No configured models are currently available. Connect a provider or import a Pi setup in General before adding model-limit policies.</p>
        </section>
      )}

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
        <p className="settings-subnav__hint">
          {selectedSection === "general"
            ? "Runtime defaults, diagnostics, auth, provider connections, and legacy import."
            : `Structured model policies for ${availableModels.length} configured model${availableModels.length === 1 ? "" : "s"}.`}
        </p>
      </div>
      <div className="task-detail-tabs__body">
        {selectedSection === "general" ? generalDetail : modelsDetail}
      </div>
    </section>
  );
}
