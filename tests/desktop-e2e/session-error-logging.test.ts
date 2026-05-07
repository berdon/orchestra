import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";
import { orchestraProjectSessionsRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop session error logging", () => {
  it.skipIf(!isDesktopE2E)("records subscribe and model-load failures in the runtime log", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const createdSession = await invokeCommand<{ id: string; title?: string | null }>(sessionId, "create_session", {
        title: "Session error logging probe",
      });
      expect(createdSession.id).toBeTruthy();

      const expectedSessionDir = orchestraProjectSessionsRoot(testHome!, "orchestra");
      expect(existsSync(expectedSessionDir)).toBe(true);

      const sessionFile = readdirSync(expectedSessionDir)
        .map((fileName) => join(expectedSessionDir, fileName))
        .find((candidate) => readFileSync(candidate, "utf8").includes(createdSession.id));

      expect(sessionFile).toBeTruthy();
      unlinkSync(sessionFile!);

      await expect(invokeCommand(sessionId, "subscribe_session", { sessionId: createdSession.id })).rejects.toThrow();
      await expect(invokeCommand(sessionId, "get_session_model_state", { sessionId: createdSession.id })).rejects.toThrow();

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "General");
      await clickSelector(sessionId, '[data-role="general-detail-tab-logs"]');
      await waitForSelector(sessionId, '[data-role="runtime-log-list"]');
      await waitForText(sessionId, "sessions.subscribe.failed");
      await waitForText(sessionId, "sessions.model_state.failed");

      const logText = await executeScript<string>(
        sessionId,
        `
          const element = document.querySelector('[data-role="runtime-log-list"]');
          return element ? element.textContent || '' : '';
        `,
      );

      expect(logText).toContain(`(sessions.subscribe.failed): Session ${createdSession.id} failed to subscribe`);
      expect(logText).toContain(`(sessions.model_state.failed): Session ${createdSession.id} failed to load model state`);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
