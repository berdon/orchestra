import { useEffect, useMemo, useState } from "react";

import type { PiOAuthFlowState, PiSetupState } from "../types";

interface PiPanelProps {
  piSetupState: PiSetupState | null;
  piOAuthFlowState: PiOAuthFlowState | null;
  piModelsJson: string;
  loadingPiSetup: boolean;
  loadingPiModelsJson: boolean;
  onRefresh: () => void;
  onSaveProviderApiKey: (providerId: string, apiKey: string) => Promise<void>;
  onRemoveProviderCredential: (providerId: string) => Promise<void>;
  onStartOAuthFlow: (providerId: string) => Promise<void>;
  onSubmitOAuthFlowInput: (value: string) => Promise<void>;
  onCancelOAuthFlow: () => Promise<void>;
  onDismissOAuthFlow: () => void;
  onImportLegacyConfig: (replaceExisting?: boolean) => Promise<void>;
  onDismissLegacyImport: () => Promise<void>;
  onSaveModelsJson: (content: string) => Promise<void>;
}

function formatStatusLabel(status?: string | null) {
  switch (status) {
    case "ready":
      return "Ready";
    case "invalid":
      return "Invalid";
    case "legacy_import_available":
      return "Legacy import available";
    case "needs_setup":
      return "Needs setup";
    default:
      return "Loading";
  }
}

function statusTone(status?: string | null) {
  switch (status) {
    case "ready":
      return "success";
    case "invalid":
      return "error";
    case "legacy_import_available":
      return "accent";
    default:
      return "warning";
  }
}

function oauthStatusTone(status?: string | null) {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return "accent";
  }
}

function oauthStatusLabel(status?: string | null) {
  switch (status) {
    case "awaiting_input":
      return "Waiting for input";
    case "succeeded":
      return "Connected";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Connecting";
  }
}

export function PiPanel({
  piSetupState,
  piOAuthFlowState,
  piModelsJson,
  loadingPiSetup,
  loadingPiModelsJson,
  onRefresh,
  onSaveProviderApiKey,
  onRemoveProviderCredential,
  onStartOAuthFlow,
  onSubmitOAuthFlowInput,
  onCancelOAuthFlow,
  onDismissOAuthFlow,
  onImportLegacyConfig,
  onDismissLegacyImport,
  onSaveModelsJson,
}: PiPanelProps) {
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [oauthInputDraft, setOauthInputDraft] = useState("");
  const [modelsDraft, setModelsDraft] = useState(piModelsJson);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [oauthCancelling, setOauthCancelling] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  useEffect(() => {
    setModelsDraft(piModelsJson);
  }, [piModelsJson]);

  useEffect(() => {
    setOauthInputDraft("");
  }, [piOAuthFlowState?.prompt?.kind, piOAuthFlowState?.prompt?.message, piOAuthFlowState?.status]);

  const apiKeyProviders = useMemo(
    () => (piSetupState?.availableProviders ?? []).filter((provider) => provider.authModes.includes("api_key")),
    [piSetupState?.availableProviders],
  );

  const oauthProviders = useMemo(
    () => (piSetupState?.availableProviders ?? []).filter((provider) => provider.authModes.includes("oauth")),
    [piSetupState?.availableProviders],
  );

  async function handleSaveProviderApiKey(providerId: string) {
    const apiKey = apiKeyDrafts[providerId]?.trim() ?? "";
    if (!apiKey) {
      setPanelError("Enter an API key before saving.");
      return;
    }

    setPanelError(null);
    setBusyProviderId(providerId);
    try {
      await onSaveProviderApiKey(providerId, apiKey);
      setApiKeyDrafts((current) => ({ ...current, [providerId]: "" }));
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to save the API key.");
    } finally {
      setBusyProviderId((current) => (current === providerId ? null : current));
    }
  }

  async function handleRemoveProviderCredential(providerId: string) {
    setPanelError(null);
    setBusyProviderId(providerId);
    try {
      await onRemoveProviderCredential(providerId);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to remove the provider credential.");
    } finally {
      setBusyProviderId((current) => (current === providerId ? null : current));
    }
  }

  async function handleStartOAuthFlow(providerId: string) {
    setPanelError(null);
    setBusyProviderId(providerId);
    try {
      await onStartOAuthFlow(providerId);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to start the OAuth flow.");
    } finally {
      setBusyProviderId((current) => (current === providerId ? null : current));
    }
  }

  async function handleSubmitOAuthInput() {
    const prompt = piOAuthFlowState?.prompt;
    if (!prompt) {
      return;
    }
    if (!prompt.allowEmpty && oauthInputDraft.trim().length === 0) {
      setPanelError("Enter a value before continuing the OAuth flow.");
      return;
    }

    setPanelError(null);
    setOauthSubmitting(true);
    try {
      await onSubmitOAuthFlowInput(oauthInputDraft);
      setOauthInputDraft("");
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to submit the OAuth input.");
    } finally {
      setOauthSubmitting(false);
    }
  }

  async function handleCancelOAuthFlow() {
    setPanelError(null);
    setOauthCancelling(true);
    try {
      await onCancelOAuthFlow();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to cancel the OAuth flow.");
    } finally {
      setOauthCancelling(false);
    }
  }

  async function handleImportLegacyConfig(replaceExisting = false) {
    setPanelError(null);
    try {
      await onImportLegacyConfig(replaceExisting);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to import the legacy Pi configuration.");
    }
  }

  async function handleSaveModels() {
    setPanelError(null);
    setSavingModels(true);
    try {
      await onSaveModelsJson(modelsDraft);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to save models.json.");
    } finally {
      setSavingModels(false);
    }
  }

  return (
    <section className="panel general-panel">
      <div className="panel__header panel__header--stacked">
        <div>
          <p className="eyebrow">Pi setup</p>
          <h3>Orchestra-managed Pi auth and models</h3>
          <p className="muted-copy">Configure Orchestra-owned Pi credentials and model sources under the Orchestra runtime instead of relying on a separate personal <code>~/.pi/agent</code> setup.</p>
        </div>
        <div className="action-cluster action-cluster--wrap">
          <span className={`status-badge status-badge--${statusTone(piSetupState?.status)}`} data-role="pi-setup-status">
            {loadingPiSetup ? "Refreshing…" : formatStatusLabel(piSetupState?.status)}
          </span>
          <button className="secondary-button" type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>

      {panelError ? <p className="error-copy">{panelError}</p> : null}

      {piOAuthFlowState ? (
        <section className="task-section task-section--compact" data-role="pi-oauth-flow-state">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">OAuth flow</p>
              <h4>{piOAuthFlowState.providerName}</h4>
              <p className="muted-copy">
                Orchestra is running the provider sign-in flow against its managed Pi auth storage.
              </p>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <span className={`status-badge status-badge--${oauthStatusTone(piOAuthFlowState.status)}`}>
                {oauthStatusLabel(piOAuthFlowState.status)}
              </span>
              {piOAuthFlowState.finishedAt ? (
                <button className="secondary-button" type="button" onClick={onDismissOAuthFlow}>
                  Dismiss
                </button>
              ) : (
                <button className="secondary-button secondary-button--danger" type="button" disabled={oauthCancelling} onClick={() => void handleCancelOAuthFlow()}>
                  {oauthCancelling ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </div>
          </div>

          {piOAuthFlowState.authUrl ? (
            <div className="workflow-validation-list muted-copy">
              <p>
                Auth URL: <a href={piOAuthFlowState.authUrl} target="_blank" rel="noreferrer">{piOAuthFlowState.authUrl}</a>
              </p>
              {piOAuthFlowState.authInstructions ? <p>{piOAuthFlowState.authInstructions}</p> : null}
              <p>{piOAuthFlowState.browserOpened ? "Orchestra attempted to open your browser automatically." : "Open the URL above in your browser to continue."}</p>
              {piOAuthFlowState.browserOpenError ? <p className="error-copy">{piOAuthFlowState.browserOpenError}</p> : null}
            </div>
          ) : null}

          {piOAuthFlowState.latestProgressMessage ? (
            <p className="muted-copy">{piOAuthFlowState.latestProgressMessage}</p>
          ) : null}

          {piOAuthFlowState.prompt ? (
            <>
              <label className="field-group">
                <span className="field-group__label">{piOAuthFlowState.prompt.kind === "manual_code" ? "Authorization code or redirect URL" : "Input"}</span>
                <input
                  className="text-input"
                  type="text"
                  placeholder={piOAuthFlowState.prompt.placeholder ?? undefined}
                  value={oauthInputDraft}
                  onChange={(event) => setOauthInputDraft(event.target.value)}
                />
              </label>
              <p className="muted-copy">{piOAuthFlowState.prompt.message}</p>
              <div className="action-cluster action-cluster--wrap">
                <button className="secondary-button" type="button" disabled={oauthSubmitting} onClick={() => void handleSubmitOAuthInput()}>
                  {oauthSubmitting ? "Submitting…" : "Continue"}
                </button>
              </div>
            </>
          ) : null}

          {piOAuthFlowState.error ? <p className="error-copy">{piOAuthFlowState.error}</p> : null}
        </section>
      ) : null}

      <section className="task-section task-section--compact">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Storage</p>
            <h4>Runtime paths</h4>
          </div>
        </div>
        <div className="workflow-validation-list muted-copy">
          <p>Agent dir: {piSetupState?.agentDir ?? "Loading…"}</p>
          <p>Auth file: {piSetupState?.authPath ?? "Loading…"}</p>
          <p>Models file: {piSetupState?.modelsPath ?? "Loading…"}</p>
          {piSetupState?.legacyAgentDir ? <p>Legacy import source: {piSetupState.legacyAgentDir}</p> : null}
        </div>
        {(piSetupState?.issues.length || piSetupState?.warnings.length) ? (
          <ul className="workflow-validation-list">
            {piSetupState.issues.map((issue) => (
              <li key={`issue-${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
            {piSetupState.warnings.map((warning) => (
              <li key={`warning-${warning.code}-${warning.message}`}>{warning.message}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {piSetupState?.importState.canImportLegacy ? (
        <section className="task-section task-section--compact">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Legacy import</p>
              <h4>Import an existing Pi setup</h4>
              <p className="muted-copy">Copy <code>auth.json</code> and <code>models.json</code> from your personal Pi setup into Orchestra-managed storage. This import is explicit and one-time.</p>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" type="button" onClick={() => void handleImportLegacyConfig(false)}>
                Import legacy setup
              </button>
              <button className="secondary-button" type="button" onClick={() => void onDismissLegacyImport().catch((error) => setPanelError(error instanceof Error ? error.message : "Unable to dismiss the legacy import prompt."))}>
                Dismiss for now
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="task-section task-section--compact">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Providers</p>
            <h4>API-key connections</h4>
            <p className="muted-copy">Save provider credentials into Orchestra-managed <code>auth.json</code>. Use these cards for provider-backed built-in models without editing Pi files by hand.</p>
          </div>
        </div>
        <div className="task-section-list">
          {apiKeyProviders.map((provider) => (
            <section className="task-section task-section--compact" key={provider.id} data-role={`pi-provider-${provider.id}`}>
              <div className="task-section__header">
                <div>
                  <p className="eyebrow">{provider.name}</p>
                  <h4>{provider.connected ? (provider.usingOAuth ? "Connected via OAuth" : "Connected via API key") : "Not connected"}</h4>
                  <p className="muted-copy">Available models right now: {provider.modelCount}</p>
                </div>
                {provider.connected ? (
                  <button className="secondary-button secondary-button--danger" type="button" disabled={busyProviderId === provider.id} onClick={() => void handleRemoveProviderCredential(provider.id)}>
                    {busyProviderId === provider.id ? "Removing…" : "Disconnect"}
                  </button>
                ) : null}
              </div>
              <label className="field-group">
                <span className="field-group__label">API key</span>
                <input
                  className="text-input"
                  type="password"
                  placeholder={`Save a ${provider.name} API key`}
                  value={apiKeyDrafts[provider.id] ?? ""}
                  onChange={(event) => setApiKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
                />
              </label>
              <div className="action-cluster action-cluster--wrap">
                <button className="secondary-button" type="button" disabled={busyProviderId === provider.id} onClick={() => void handleSaveProviderApiKey(provider.id)}>
                  {busyProviderId === provider.id ? "Saving…" : "Save API key"}
                </button>
              </div>
            </section>
          ))}
          {!apiKeyProviders.length ? <p className="muted-copy">No API-key providers are available in the current Pi runtime catalog.</p> : null}
        </div>
      </section>

      {oauthProviders.length ? (
        <section className="task-section task-section--compact">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">OAuth providers</p>
              <h4>Subscription and browser/device-code providers</h4>
              <p className="muted-copy">Use Orchestra-started browser, callback-server, and device-code flows to connect subscription-backed providers directly into Orchestra-managed Pi auth storage.</p>
            </div>
          </div>
          <div className="task-section-list">
            {oauthProviders.map((provider) => {
              const flowActive = piOAuthFlowState?.providerId === provider.id && !piOAuthFlowState?.finishedAt;
              return (
                <section className="task-section task-section--compact" key={`oauth-${provider.id}`} data-role={`pi-oauth-provider-${provider.id}`}>
                  <div className="task-section__header">
                    <div>
                      <p className="eyebrow">{provider.name}</p>
                      <h4>{provider.connected && provider.usingOAuth ? "Connected via OAuth" : provider.connected ? "Connected via API key" : "Not connected"}</h4>
                      <p className="muted-copy">
                        {provider.usesCallbackServer ? "Uses a local callback server with manual paste fallback." : "Uses browser/device-code verification without a local callback server."}
                      </p>
                    </div>
                    {provider.connected && provider.usingOAuth ? (
                      <button className="secondary-button secondary-button--danger" type="button" disabled={busyProviderId === provider.id || flowActive} onClick={() => void handleRemoveProviderCredential(provider.id)}>
                        {busyProviderId === provider.id ? "Removing…" : "Disconnect"}
                      </button>
                    ) : (
                      <button className="secondary-button" type="button" disabled={busyProviderId === provider.id || flowActive} onClick={() => void handleStartOAuthFlow(provider.id)}>
                        {busyProviderId === provider.id ? "Starting…" : provider.id === "anthropic" ? "Connect subscription" : "Connect with OAuth"}
                      </button>
                    )}
                  </div>
                  <p className="muted-copy">Available models right now: {provider.modelCount}</p>
                </section>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="task-section task-section--compact">
        <div className="task-section__header">
          <div>
            <p className="eyebrow">Models</p>
            <h4>Advanced models.json editor</h4>
            <p className="muted-copy">Use the raw Pi-compatible <code>models.json</code> editor for advanced custom providers, imported configs, or provider/model definitions that Orchestra does not model directly yet.</p>
          </div>
          <div className="action-cluster action-cluster--wrap">
            <button className="secondary-button" type="button" disabled={savingModels || loadingPiModelsJson} onClick={() => setModelsDraft(piModelsJson)}>
              Reset draft
            </button>
            <button className="secondary-button" type="button" disabled={savingModels || loadingPiModelsJson} onClick={() => void handleSaveModels()}>
              {savingModels ? "Saving…" : "Save models.json"}
            </button>
          </div>
        </div>
        <label className="field-group">
          <span className="field-group__label">models.json</span>
          <textarea
            className="text-area general-panel__prompt-template"
            rows={18}
            value={modelsDraft}
            disabled={loadingPiModelsJson}
            onChange={(event) => setModelsDraft(event.target.value)}
          />
        </label>
      </section>
    </section>
  );
}
