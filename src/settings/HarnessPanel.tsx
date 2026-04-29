import type { ComponentProps } from "react";
import { useEffect, useState } from "react";

import { PiPanel } from "./PiPanel";
import type { PiRuntimeDiagnostics, PiRuntimeSettings } from "../types";

type HarnessPanelProps = ComponentProps<typeof PiPanel> & {
  piRuntimeSettings: PiRuntimeSettings | null;
  piRuntimeDiagnostics: PiRuntimeDiagnostics | null;
  onSavePiRuntimeSettings: (input: { extraExtensions: string[]; defaultCompactionWindow: string }) => void;
  onImportLegacyPiConfiguration: (input: { importAuth: boolean; importModels: boolean }) => void;
};

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function HarnessPanel({
  piRuntimeSettings,
  piRuntimeDiagnostics,
  onSavePiRuntimeSettings,
  onImportLegacyPiConfiguration,
  ...piPanelProps
}: HarnessPanelProps) {
  const packageDiagnostics = piPanelProps.piSetupState?.packageDiagnostics ?? null;
  const [piExtensionsDraft, setPiExtensionsDraft] = useState("");
  const [defaultCompactionWindowDraft, setDefaultCompactionWindowDraft] = useState("10%");

  useEffect(() => {
    setPiExtensionsDraft(piRuntimeSettings?.extraExtensions.join("\n") ?? "");
    setDefaultCompactionWindowDraft(piRuntimeSettings?.defaultCompactionWindow ?? "10%");
  }, [piRuntimeSettings?.defaultCompactionWindow, piRuntimeSettings?.extraExtensions]);

  return (
    <section className="panel-stack">
      <section className="panel general-panel">
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
                onClick={() =>
                  onSavePiRuntimeSettings({
                    extraExtensions: piExtensionsDraft.split(/\r?\n/g),
                    defaultCompactionWindow: defaultCompactionWindowDraft,
                  })
                }
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
      </section>

      <PiPanel {...piPanelProps} />
    </section>
  );
}
