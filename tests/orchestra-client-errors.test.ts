import { describe, expect, it } from "vitest";

import { toOrchestraClientError } from "../src/lib/orchestraClient/errors";
import {
  getModelAuthFailureSettingsTarget,
  toUiErrorState,
} from "../src/lib/orchestraData/errors";

describe("orchestra client session error normalization", () => {
  it("downgrades canonical session drift diagnostics to a user-safe not-found session message", () => {
    const error = toOrchestraClientError(
      "Session 123e4567-e89b-12d3-a456-426614174000 was not found in canonical session rows for project orchestra; run explicit session reconciliation to inspect legacy drift",
      {
        operation: "sessions.get",
        source: "tauri",
        fallbackMessage: "sessions.get failed.",
      },
    );

    expect(error.code).toBe("not_found");
    expect(error.userMessage).toBe(
      "This session is no longer available. Refresh the session list or reopen the latest chat to continue.",
    );
    expect(error.message).toContain("explicit session reconciliation");
  });

  it("leaves unrelated session transport errors unchanged", () => {
    const error = toOrchestraClientError(
      "Session websocket transport disconnected unexpectedly",
      {
        operation: "sessions.get",
        source: "tauri",
        fallbackMessage: "sessions.get failed.",
      },
    );

    expect(error.code).toBe("transport");
    expect(error.userMessage).toBeNull();
  });

  it("turns embedded model-auth failures into setup-required UI errors with a Harness setup target", () => {
    const uiError = toUiErrorState(
      '__ORCHESTRA_MODEL_AUTH_ERROR__:{"kind":"model_auth_required","code":"model_auth_required","reason":"missing","providerId":"openai-codex","providerName":"OpenAI Codex","modelId":"gpt-5.4","message":"The selected model can’t run because OpenAI Codex isn’t connected in Harness.","detail":"Reconnect OpenAI Codex in Settings → Harness → Setup, then retry.","settingsTab":"harness","settingsDetailTab":"setup","rawMessage":"OpenAI Codex missing credential in auth.json"}',
      "Session action failed.",
    );

    expect(uiError.kind).toBe("setup_required");
    expect(uiError.title).toBe("Harness setup required");
    expect(uiError.message).toContain("OpenAI Codex");
    expect(uiError.detail).toContain("Settings → Harness → Setup");
    expect(getModelAuthFailureSettingsTarget(uiError)).toEqual({
      tab: "harness",
      detailTab: "setup",
      providerId: "openai-codex",
    });
  });
});
