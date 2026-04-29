import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  sleep,
} from "./driver";

const runtimeValidationMode = process.env.ORCHESTRA_DESKTOP_E2E_RUNTIME_VALIDATION_MODE
  ?? (process.env.ORCHESTRA_DESKTOP_E2E_PACKAGED_VALIDATION === "1" ? "packaged" : "");
const isBundledRuntimeValidation = runtimeValidationMode === "packaged" || runtimeValidationMode === "podman";
const expectPackagedMode = runtimeValidationMode === "packaged";
const expectedRuntimeMode = expectPackagedMode ? "packaged" : "development";
const expectedRuntimePathFragment = process.env.ORCHESTRA_DESKTOP_E2E_EXPECT_RUNTIME_PATH_FRAGMENT ?? "pi-runtime";
const expectPromptSuccess = process.env.ORCHESTRA_PACKAGED_RUNTIME_EXPECT_PROMPT_SUCCESS === "1";
const testHome = process.env.ORCHESTRA_TEST_HOME ?? "";

async function waitForAssistantText(webdriverSessionId: string, sessionId: string, expectedText: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastMessages: string[] = [];

  while (Date.now() < deadline) {
    const record = await invokeCommand<any>(webdriverSessionId, "get_session_record", { sessionId });
    lastMessages = Array.isArray(record?.events)
      ? record.events
          .filter((event: any) => event?.kind === "assistant")
          .map((event: any) => String(event?.message ?? ""))
      : [];

    if (lastMessages.some((message) => message.includes(expectedText))) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for assistant text ${expectedText}. Last assistant messages: ${JSON.stringify(lastMessages)}`);
}

describe("bundled-runtime validation", () => {
  it.skipIf(!isBundledRuntimeValidation)("launches the app with the bundled Pi runtime and Orchestra-managed Pi setup", async () => {
    const webdriverSessionId = await createReadyWebdriverSession(120_000);
    try {
      await ensureReactReady(webdriverSessionId, 120_000);

      const appInfo = await invokeCommand<any>(webdriverSessionId, "get_app_info");
      expect(appInfo?.piRuntimeDiagnostics?.runtime?.packagedMode).toBe(expectPackagedMode);
      expect(appInfo?.piRuntimeDiagnostics?.runtime?.source).toBe("bundled");
      expect(appInfo?.piRuntimeDiagnostics?.runtime?.error ?? null).toBeNull();
      expect(String(appInfo?.piRuntimeDiagnostics?.runtime?.resolvedPath ?? "")).toContain(expectedRuntimePathFragment);
      expect(String(appInfo?.piRuntimeDiagnostics?.auth?.agentDir ?? "")).toContain(".orchestra/runtime/pi/agent");
      expect(String(appInfo?.piRuntimeDiagnostics?.auth?.agentDir ?? "")).not.toContain("/.pi/");
      if (testHome) {
        expect(String(appInfo?.piRuntimeDiagnostics?.auth?.agentDir ?? "")).toContain(testHome);
      }

      const setupState = await invokeCommand<any>(webdriverSessionId, "get_pi_setup_state");
      expect(setupState?.status).toBe("ready");
      expect(String(setupState?.agentDir ?? "")).toContain(".orchestra/runtime/pi/agent");
      expect(setupState?.packageDiagnostics?.bun?.available).toBe(true);
      expect(String(setupState?.packageDiagnostics?.bun?.message ?? "")).toContain("Bundled Bun is available");
      expect(String(setupState?.packageDiagnostics?.bun?.path ?? "")).toContain(expectedRuntimePathFragment);
      expect(setupState?.packageDiagnostics?.blocking).toBe(false);

      const createdSession = await invokeCommand<any>(webdriverSessionId, "create_session", {
        title: "Packaged runtime smoke",
        projectSlug: "orchestra",
      });
      expect(createdSession?.id).toBeTruthy();

      const runtimeDetails = await invokeCommand<any>(webdriverSessionId, "get_session_runtime_details", {
        sessionId: createdSession.id,
      });
      expect(runtimeDetails?.piRuntimeSource).toBe("bundled");
      expect(runtimeDetails?.piRuntimeMode).toBe(expectedRuntimeMode);
      expect(runtimeDetails?.piRuntimeStatus).toBe("healthy");
      expect(String(runtimeDetails?.piExecutablePath ?? "")).toContain(expectedRuntimePathFragment);
      expect(String(runtimeDetails?.piRuntimeManifestPath ?? "")).toContain("manifest.json");
      expect(Array.isArray(runtimeDetails?.blockedExtraExtensions) ? runtimeDetails.blockedExtraExtensions : []).toEqual([]);

      if (expectPromptSuccess) {
        const expectedToken = "PACKAGED_RUNTIME_SMOKE_OK";
        await invokeCommand<any>(webdriverSessionId, "send_session_message", {
          sessionId: createdSession.id,
          runId: `packaged-runtime-smoke-${Date.now()}`,
          message: `Reply with the exact text ${expectedToken} and nothing else.`,
        });
        await waitForAssistantText(webdriverSessionId, createdSession.id, expectedToken);
      }
    } finally {
      await deleteWebdriverSession(webdriverSessionId);
    }
  }, 240_000);
});
