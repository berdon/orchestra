import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getCurrentUrl,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import { orchestraProjectSessionsRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const tauriBinary = process.env.ORCHESTRA_TAURI_BINARY;
const testHome = process.env.ORCHESTRA_TEST_HOME;
const expectedPreviewUrl = process.env.ORCHESTRA_DESKTOP_E2E_PREVIEW_URL ?? "http://127.0.0.1:1420";
const normalizeUrl = (value: string) => (value.endsWith("/") ? value : `${value}/`);
const matchesExpectedLaunchUrl = (value: string) => (
  value.startsWith("tauri://localhost")
  || value.startsWith("http://tauri.localhost")
  || value.startsWith("https://tauri.localhost")
  || value === expectedPreviewUrl
  || value.startsWith(normalizeUrl(expectedPreviewUrl))
);

describe("desktop Tauri webdriver harness", () => {
  it.skipIf(!isDesktopE2E)("launches the real app and creates a real session file", async () => {
    expect(tauriBinary).toBeTruthy();
    expect(testHome).toBeTruthy();

    const expectedSessionDir = orchestraProjectSessionsRoot(testHome!, "orchestra");
    const debugSourcePath = join(testHome!, "desktop-source.html");
    const beforeFiles = existsSync(expectedSessionDir) ? readdirSync(expectedSessionDir).length : 0;

    const sessionId = await createReadyWebdriverSession();
    try {
      const initialUrl = await getCurrentUrl(sessionId);
      const initialDom = await ensureReactReady(sessionId);
      writeFileSync(debugSourcePath, initialDom.html, "utf8");
      expect(matchesExpectedLaunchUrl(initialUrl)).toBe(true);

      const createSessionState = await waitForSelector(sessionId, '[data-role="create-session"]');
      writeFileSync(debugSourcePath, createSessionState.html, "utf8");
      await clickSelector(sessionId, '[data-role="create-session"]');
      await sleep(500);

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (existsSync(expectedSessionDir) && readdirSync(expectedSessionDir).length > beforeFiles) {
          break;
        }
        await sleep(500);
      }

      expect(existsSync(expectedSessionDir)).toBe(true);
      const afterFiles = readdirSync(expectedSessionDir);
      expect(afterFiles.length).toBeGreaterThan(beforeFiles);

      const newest = afterFiles
        .map((fileName) => ({ fileName, fullPath: join(expectedSessionDir, fileName) }))
        .sort((left, right) => right.fileName.localeCompare(left.fileName))[0];
      expect(newest).toBeTruthy();

      const content = readFileSync(newest!.fullPath, "utf8");
      expect(content).toContain('"type":"session"');
      await waitForText(sessionId, "Real pi session ready");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 90_000);
});
