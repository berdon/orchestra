import { useEffect, useMemo, useRef, useState } from "react";

import type {
  PiOAuthFlowState,
  PiProviderAuthMethodSummary,
  PiProviderSetupSummary,
  PiSetupState,
} from "../types";

interface PiPanelProps {
  piSetupState: PiSetupState | null;
  piOAuthFlowState: PiOAuthFlowState | null;
  piModelsJson: string;
  loadingPiSetup: boolean;
  loadingPiModelsJson: boolean;
  onRefresh: () => void;
  onSaveProviderApiKey: (providerId: string, apiKey: string) => Promise<void>;
  onRemoveProviderCredential: (providerId: string) => Promise<void>;
  onStartOAuthFlow: (providerId: string, methodId?: string | null) => Promise<void>;
  onSubmitOAuthFlowInput: (value: string) => Promise<void>;
  onCancelOAuthFlow: () => Promise<void>;
  onDismissOAuthFlow: () => Promise<void>;
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
      return "Couldn’t connect";
    case "cancelled":
      return "Cancelled";
    default:
      return "Connecting";
  }
}

function getDefaultOAuthMethod(methods?: PiProviderAuthMethodSummary[] | null) {
  if (!methods?.length) {
    return null;
  }
  return methods.find((method) => method.isDefault) ?? methods[0] ?? null;
}

function providerOAuthDescription(provider: PiProviderSetupSummary) {
  const methods = provider.oauthMethods ?? [];
  const hasBrowser = methods.some((method) => method.kind === "browser");
  const hasDeviceCode = methods.some((method) => method.kind === "device_code");

  if (hasBrowser && hasDeviceCode) {
    return "Choose a browser sign-in flow or use a device code on the verification page.";
  }
  if (hasDeviceCode) {
    return "Use the verification page and device code to connect this provider.";
  }
  if (provider.usesCallbackServer) {
    return "Finish sign-in in your browser. If needed, you can paste the redirect URL back here.";
  }
  return "Finish sign-in in your browser to connect this provider.";
}

function oauthCardHeading(provider: PiProviderSetupSummary, flow: PiOAuthFlowState | null) {
  if (flow?.status === "succeeded") {
    return "Connected";
  }
  if (flow) {
    switch (flow.status) {
      case "failed":
        return "Sign-in needs attention";
      case "cancelled":
        return "Sign-in cancelled";
      default:
        return flow.methodKind === "device_code" ? "Connecting with a device code" : "Connecting";
    }
  }
  if (provider.connected && provider.usingOAuth) {
    return "Connected";
  }
  if (provider.connected) {
    return "Connected via API key";
  }
  return "Not connected";
}

function oauthPrimaryButtonLabel(provider: PiProviderSetupSummary, method: PiProviderAuthMethodSummary | null) {
  if (provider.id === "anthropic" && method?.kind === "browser") {
    return "Connect subscription";
  }
  return "Connect";
}

interface OAuthConnectButtonProps {
  provider: PiProviderSetupSummary;
  disabled: boolean;
  busy: boolean;
  onSelect: (method: PiProviderAuthMethodSummary) => void;
}

function OAuthConnectButton({ provider, disabled, busy, onSelect }: OAuthConnectButtonProps) {
  const methods = provider.oauthMethods ?? [];
  const primaryMethod = getDefaultOAuthMethod(methods);
  const alternateMethods = primaryMethod
    ? methods.filter((method) => method.id !== primaryMethod.id)
    : [];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current || !(event.target instanceof Node)) {
        return;
      }
      if (!rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!alternateMethods.length || disabled) {
      setOpen(false);
    }
  }, [alternateMethods.length, disabled]);

  if (!primaryMethod) {
    return null;
  }

  const primaryLabel = oauthPrimaryButtonLabel(provider, primaryMethod);

  if (!alternateMethods.length) {
    return (
      <button
        className="secondary-button"
        type="button"
        data-role={`pi-oauth-connect-${provider.id}`}
        disabled={disabled}
        onClick={() => onSelect(primaryMethod)}
      >
        {busy ? "Starting…" : primaryLabel}
      </button>
    );
  }

  return (
    <div className="pi-oauth-method-menu task-relane-menu" ref={rootRef}>
      <div className="pi-oauth-method-menu__group">
        <button
          className="secondary-button"
          type="button"
          data-role={`pi-oauth-connect-${provider.id}`}
          disabled={disabled}
          onClick={() => onSelect(primaryMethod)}
        >
          {busy ? "Starting…" : primaryLabel}
        </button>
        <button
          className="secondary-button pi-oauth-method-menu__trigger"
          type="button"
          data-role={`pi-oauth-connect-menu-${provider.id}`}
          aria-expanded={open}
          aria-haspopup="menu"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          ▾
        </button>
      </div>
      {open ? (
        <div className="task-relane-menu__dropdown pi-oauth-method-menu__dropdown" role="menu">
          {alternateMethods.map((method) => (
            <button
              key={method.id}
              className="secondary-button task-relane-menu__option"
              type="button"
              role="menuitem"
              data-role={`pi-oauth-connect-method-${provider.id}-${method.id}`}
              onClick={() => {
                setOpen(false);
                onSelect(method);
              }}
            >
              <strong>{method.label}</strong>
              <span className="muted-copy">
                {method.kind === "device_code" ? "Use the verification page and device code." : "Finish sign-in in your browser."}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  const [oauthDismissing, setOauthDismissing] = useState(false);
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
      setPanelError(error instanceof Error ? error.message : "Unable to reset the provider connection.");
    } finally {
      setBusyProviderId((current) => (current === providerId ? null : current));
    }
  }

  async function handleStartOAuthFlow(providerId: string, methodId?: string | null) {
    setPanelError(null);
    setBusyProviderId(providerId);
    try {
      await onStartOAuthFlow(providerId, methodId);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to start sign-in.");
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
      setPanelError("Enter a value before continuing.");
      return;
    }

    setPanelError(null);
    setOauthSubmitting(true);
    try {
      await onSubmitOAuthFlowInput(oauthInputDraft);
      setOauthInputDraft("");
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to continue sign-in.");
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
      setPanelError(error instanceof Error ? error.message : "Unable to cancel sign-in.");
    } finally {
      setOauthCancelling(false);
    }
  }

  async function handleDismissOAuthFlow() {
    setPanelError(null);
    setOauthDismissing(true);
    try {
      await onDismissOAuthFlow();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "Unable to dismiss the sign-in state.");
    } finally {
      setOauthDismissing(false);
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
          <p className="eyebrow">Harness setup</p>
          <h3>Harness auth and models</h3>
          <p className="muted-copy">Configure Orchestra-owned harness credentials and model sources under the Orchestra runtime instead of relying on a separate personal <code>~/.pi/agent</code> setup.</p>
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
          <p>Settings file: {piSetupState?.settingsPath ?? "Loading…"}</p>
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
                    {busyProviderId === provider.id ? "Resetting…" : "Reset"}
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
              <h4>Subscription and OAuth-backed providers</h4>
              <p className="muted-copy">Connect supported providers directly into Orchestra-managed Pi auth storage with browser sign-in or device-code verification where available.</p>
            </div>
          </div>
          <div className="task-section-list">
            {oauthProviders.map((provider) => {
              const providerFlow = piOAuthFlowState?.providerId === provider.id ? piOAuthFlowState : null;
              const flowActive = Boolean(providerFlow && !providerFlow.finishedAt && providerFlow.status !== "succeeded");
              const flowFinished = Boolean(providerFlow?.finishedAt);
              const promptLabel = providerFlow?.prompt?.kind === "manual_code"
                ? "Authorization code or redirect URL"
                : "Input";

              return (
                <section className="task-section task-section--compact" key={`oauth-${provider.id}`} data-role={`pi-oauth-provider-${provider.id}`}>
                  <div className="task-section__header">
                    <div>
                      <p className="eyebrow">{provider.name}</p>
                      <h4>{oauthCardHeading(provider, providerFlow)}</h4>
                      <p className="muted-copy">
                        {providerFlow?.status === "succeeded"
                          ? "Connected. Finishing setup…"
                          : providerOAuthDescription(provider)}
                      </p>
                    </div>
                    {provider.connected && provider.usingOAuth && !providerFlow ? (
                      <button
                        className="secondary-button secondary-button--danger"
                        type="button"
                        data-role={`pi-oauth-reset-${provider.id}`}
                        disabled={busyProviderId === provider.id}
                        onClick={() => void handleRemoveProviderCredential(provider.id)}
                      >
                        {busyProviderId === provider.id ? "Resetting…" : "Reset"}
                      </button>
                    ) : !providerFlow ? (
                      <OAuthConnectButton
                        provider={provider}
                        disabled={busyProviderId === provider.id}
                        busy={busyProviderId === provider.id}
                        onSelect={(method) => void handleStartOAuthFlow(provider.id, method.id)}
                      />
                    ) : null}
                  </div>

                  <p className="muted-copy">Available models right now: {provider.modelCount}</p>

                  {providerFlow ? (
                    <div className="pi-oauth-provider__flow" data-role={`pi-oauth-flow-${provider.id}`}>
                      <div className="action-cluster action-cluster--wrap">
                        <span className={`status-badge status-badge--${oauthStatusTone(providerFlow.status)}`} data-role={`pi-oauth-status-${provider.id}`}>
                          {oauthStatusLabel(providerFlow.status)}
                        </span>
                        {flowActive ? (
                          <button
                            className="secondary-button secondary-button--danger"
                            type="button"
                            data-role={`pi-oauth-cancel-${provider.id}`}
                            disabled={oauthCancelling}
                            onClick={() => void handleCancelOAuthFlow()}
                          >
                            {oauthCancelling ? "Cancelling…" : "Cancel"}
                          </button>
                        ) : null}
                        {flowFinished && providerFlow.status !== "succeeded" ? (
                          <>
                            <button
                              className="secondary-button"
                              type="button"
                              data-role={`pi-oauth-retry-${provider.id}`}
                              disabled={busyProviderId === provider.id}
                              onClick={() => void handleStartOAuthFlow(provider.id, providerFlow.methodId)}
                            >
                              {busyProviderId === provider.id ? "Starting…" : "Try again"}
                            </button>
                            <button
                              className="secondary-button secondary-button--danger"
                              type="button"
                              data-role={`pi-oauth-reset-${provider.id}`}
                              disabled={busyProviderId === provider.id}
                              onClick={() => void handleRemoveProviderCredential(provider.id)}
                            >
                              {busyProviderId === provider.id ? "Resetting…" : "Reset"}
                            </button>
                            <button
                              className="secondary-button"
                              type="button"
                              data-role={`pi-oauth-dismiss-${provider.id}`}
                              disabled={oauthDismissing}
                              onClick={() => void handleDismissOAuthFlow()}
                            >
                              {oauthDismissing ? "Dismissing…" : "Dismiss"}
                            </button>
                          </>
                        ) : null}
                      </div>

                      {providerFlow.authStep ? (
                        <div className="workflow-validation-list muted-copy">
                          <p>
                            <a
                              href={providerFlow.authStep.url}
                              target="_blank"
                              rel="noreferrer"
                              data-role={`pi-oauth-link-${provider.id}`}
                            >
                              {providerFlow.authStep.linkLabel}
                            </a>
                          </p>
                          {providerFlow.authStep.userCode ? (
                            <p data-role={`pi-oauth-user-code-${provider.id}`}>
                              Device code: <code>{providerFlow.authStep.userCode}</code>
                            </p>
                          ) : null}
                          {providerFlow.authStep.instructions ? <p>{providerFlow.authStep.instructions}</p> : null}
                          {providerFlow.browserOpenError ? <p className="error-copy">{providerFlow.browserOpenError}</p> : null}
                        </div>
                      ) : null}

                      {providerFlow.latestProgressMessage ? (
                        <p className="muted-copy">{providerFlow.latestProgressMessage}</p>
                      ) : null}

                      {providerFlow.prompt ? (
                        <>
                          <label className="field-group">
                            <span className="field-group__label">{promptLabel}</span>
                            <input
                              className="text-input"
                              type="text"
                              data-role={`pi-oauth-input-${provider.id}`}
                              placeholder={providerFlow.prompt.placeholder ?? undefined}
                              value={oauthInputDraft}
                              onChange={(event) => setOauthInputDraft(event.target.value)}
                            />
                          </label>
                          <p className="muted-copy">{providerFlow.prompt.message}</p>
                          <div className="action-cluster action-cluster--wrap">
                            <button className="secondary-button" type="button" disabled={oauthSubmitting} onClick={() => void handleSubmitOAuthInput()}>
                              {oauthSubmitting ? "Submitting…" : "Continue"}
                            </button>
                          </div>
                        </>
                      ) : null}

                      {providerFlow.error ? <p className="error-copy">{providerFlow.error}</p> : null}
                    </div>
                  ) : null}
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
