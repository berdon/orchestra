import { type FormEvent, useMemo, useState } from "react";

import type { OrchestraClientBootstrap } from "../lib/orchestraClient";
import type { RemotePairingCompleteInput } from "../types";

interface HostedWebAuthGateProps {
  bootstrap: OrchestraClientBootstrap;
  pending?: boolean;
  error?: string | null;
  onPair(input: RemotePairingCompleteInput): Promise<void>;
}

function resolveDefaultBrowserLabel() {
  if (typeof navigator === "undefined") {
    return "Orchestra Browser";
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = navigatorWithUserAgentData.userAgentData?.platform || navigator.platform || "Browser";
  return `Orchestra Browser (${platform})`;
}

export function HostedWebAuthGate({ bootstrap, pending = false, error = null, onPair }: HostedWebAuthGateProps) {
  const [pairingCode, setPairingCode] = useState("");
  const [browserLabel, setBrowserLabel] = useState(resolveDefaultBrowserLabel);

  const currentOrigin = useMemo(() => {
    if (typeof window === "undefined") {
      return bootstrap.urls.apiBaseUrl ?? "";
    }
    return window.location.origin;
  }, [bootstrap.urls.apiBaseUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onPair({
      code: pairingCode.trim(),
      label: browserLabel.trim() || null,
      platform: "browser",
      pushToken: null,
    });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        background: "#08111b",
      }}
    >
      <section className="panel" data-role="hosted-web-auth-gate" style={{ width: "min(42rem, 100%)" }}>
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Hosted Orchestra web app</p>
            <h1 style={{ marginBottom: "0.75rem" }}>Connect this browser to Orchestra</h1>
            <p className="muted-copy" style={{ marginBottom: 0 }}>
              This is the main shared Orchestra frontend running in hosted-web mode. Enter a one-time pairing code from the desktop host to
              start a same-origin browser session on <code data-role="hosted-web-current-origin">{currentOrigin}</code>.
            </p>
          </div>
        </div>

        <form className="task-section-list" onSubmit={(event) => void handleSubmit(event)}>
          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Sign in</p>
                <h4>Pair browser session</h4>
              </div>
            </div>
            <p className="muted-copy">
              After pairing, Orchestra sets an HttpOnly cookie on this origin and reloads the shared app with the normal hosted-web bootstrap.
            </p>
            <label className="field-group">
              <span className="field-group__label">Pairing code</span>
              <input
                className="text-input"
                data-role="hosted-web-pairing-code"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                disabled={pending}
                required
              />
            </label>
            <label className="field-group">
              <span className="field-group__label">Browser label</span>
              <input
                className="text-input"
                data-role="hosted-web-browser-label"
                value={browserLabel}
                onChange={(event) => setBrowserLabel(event.target.value)}
                placeholder="Orchestra Browser"
                autoComplete="off"
                disabled={pending}
              />
            </label>
            {error ? <p className="error-copy" data-role="hosted-web-auth-error">{error}</p> : null}
            <div className="action-cluster action-cluster--wrap">
              <button
                className="primary-button"
                data-role="hosted-web-pair-submit"
                type="submit"
                disabled={pending || pairingCode.trim().length === 0}
              >
                {pending ? "Pairing…" : "Pair browser"}
              </button>
            </div>
          </section>
        </form>
      </section>
    </div>
  );
}
