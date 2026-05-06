import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";
import { orchestraProjectRoot, orchestraProjectSessionsRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop session missing cwd recovery", () => {
  it.skipIf(!isDesktopE2E)("reuses a valid project runtime root when a stored session cwd is missing", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const createdSession = await invokeCommand<{ id: string }>(sessionId, "create_session", {
        title: "Session missing cwd logging probe",
      });
      expect(createdSession.id).toBeTruthy();

      const expectedSessionDir = orchestraProjectSessionsRoot(testHome!, "orchestra");
      expect(existsSync(expectedSessionDir)).toBe(true);

      const sessionFile = readdirSync(expectedSessionDir)
        .map((fileName) => join(expectedSessionDir, fileName))
        .find((candidate) => readFileSync(candidate, "utf8").includes(createdSession.id));

      expect(sessionFile).toBeTruthy();

      const missingCwd = join(orchestraProjectRoot(testHome!, "orchestra"), "missing-runtime-cwd");
      const lines = readFileSync(sessionFile!, "utf8").trimEnd().split("\n");
      const header = JSON.parse(lines[0]);
      header.cwd = missingCwd;
      lines[0] = JSON.stringify(header);
      writeFileSync(sessionFile!, `${lines.join("\n")}\n`, "utf8");

      await invokeCommand(sessionId, "stop_session_runtime", { sessionId: createdSession.id });

      const subscribed = await invokeCommand<{ id: string; subscribed: boolean }>(sessionId, "subscribe_session", {
        sessionId: createdSession.id,
      });
      expect(subscribed.id).toBe(createdSession.id);
      expect(subscribed.subscribed).toBe(true);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "General");
      await clickByText(sessionId, "button", "Logs");
      await waitForSelector(sessionId, '[data-role="runtime-log-list"]');
      await waitForText(sessionId, "sessions.runtime.spawn.request");

      const logText = await executeScript<string>(
        sessionId,
        `
          const element = document.querySelector('[data-role="runtime-log-list"]');
          return element ? element.textContent || '' : '';
        `,
      );

      expect(logText).toContain("(sessions.runtime.spawn.request):");
      expect(logText).toContain(`session_dir=${expectedSessionDir}`);
      expect(logText).toContain("pi=");
      expect(logText).toContain("orchestra_extension=");
      expect(logText).toContain("extra_extensions=");
      expect(logText).not.toContain("(sessions.runtime.spawn.failed):");
      expect(logText).not.toContain(`cwd=${missingCwd}`);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
