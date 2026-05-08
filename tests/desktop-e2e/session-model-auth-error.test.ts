import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const fixtureLogPath = process.env.ORCHESTRA_FAKE_PI_MODEL_AUTH_LOG_PATH;

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function openSessionByTitle(sessionId: string, title: string) {
  await clickByText(sessionId, "button", "Sessions");
  await waitForText(sessionId, title, 30_000);
  await clickByText(sessionId, '[data-role="session-link"]', title);
  await waitForSelector(sessionId, '[data-role="session-chat-panel"]');
  await waitForSelector(sessionId, '[data-role="composer-input"]');
}

function readFixtureLogEntries() {
  if (!fixtureLogPath || !existsSync(fixtureLogPath)) {
    return [] as Array<Record<string, unknown>>;
  }
  return readFileSync(fixtureLogPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("desktop session model-auth failure UX", () => {
  it.skipIf(!isDesktopE2E)("shows an inline Harness setup error and deep-links to Harness → Setup when OpenAI Codex auth is removed", async () => {
    expect(fixtureLogPath).toBeTruthy();

    const webdriverSessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(webdriverSessionId);

      await invokeCommand(webdriverSessionId, "set_pi_provider_api_key", {
        providerId: "openai-codex",
        apiKey: "fixture-connected-token",
      });
      await invokeCommand(webdriverSessionId, "save_pi_models_json", {
        content: JSON.stringify({
          providers: {
            "openai-codex": {
              api: "openai-codex-responses",
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT 5.4",
                  reasoning: true,
                  input: ["text"],
                },
              ],
            },
          },
        }, null, 2),
      });

      const createdSession = await invokeCommand<{ id: string }>(webdriverSessionId, "create_session", {
        title: "OpenAI Codex auth failure fixture",
      });
      await invokeCommand(webdriverSessionId, "set_session_model", {
        sessionId: createdSession.id,
        provider: "openai-codex",
        modelId: "gpt-5.4",
      });

      await openSessionByTitle(webdriverSessionId, "OpenAI Codex auth failure fixture");
      await invokeCommand(webdriverSessionId, "remove_pi_provider_credential", {
        providerId: "openai-codex",
      });

      await setInputValue(webdriverSessionId, '[data-role="composer-input"]', "Explain why auth failures should be actionable.");
      await clickSelector(webdriverSessionId, '[data-role="send-message"]');

      await waitForSelector(webdriverSessionId, '[data-role="session-model-auth-error"]');
      await waitForText(webdriverSessionId, "OpenAI Codex isn’t connected in Harness");
      await waitForText(webdriverSessionId, "Settings → Harness → Setup");

      const pageBannerCount = await executeScript<number>(webdriverSessionId, `
        return document.querySelectorAll('[data-role="sessions-status-error"]').length;
      `);
      expect(pageBannerCount).toBe(0);

      const pendingState = await waitForCondition(
        () => executeScript<{ pendingEvents: number; responseInProgress: boolean }>(webdriverSessionId, `
          return {
            pendingEvents: document.querySelectorAll('[data-event-pending="true"]').length,
            responseInProgress: (document.body?.innerText || '').includes('Response in progress…'),
          };
        `),
        (value) => value.pendingEvents === 0 && value.responseInProgress === false,
      );
      expect(pendingState.pendingEvents).toBe(0);
      expect(pendingState.responseInProgress).toBe(false);

      const fixtureEntry = await waitForCondition(
        async () => readFixtureLogEntries(),
        (entries) => entries.some((entry) => entry.branch === "prompt:missing" && entry.providerId === "openai-codex"),
      );
      expect(fixtureEntry.some((entry) => entry.branch === "prompt:missing")).toBe(true);

      await clickSelector(webdriverSessionId, '[data-role="session-model-auth-open-settings"]');
      await waitForText(webdriverSessionId, "Harness settings");
      await waitForSelector(webdriverSessionId, '[data-role="harness-detail-tab-setup"]');
      await waitForCondition(
        () => executeScript<{ harnessSelected: string | null; detailSelected: string | null; providerVisible: boolean }>(webdriverSessionId, `
          const harnessTab = document.querySelector('[data-role="settings-tab-harness"]');
          const setupTab = document.querySelector('[data-role="harness-detail-tab-setup"]');
          return {
            harnessSelected: harnessTab?.getAttribute('aria-selected') || null,
            detailSelected: setupTab?.getAttribute('aria-selected') || null,
            providerVisible: Boolean(document.querySelector('[data-role="pi-provider-openai-codex"], [data-role="pi-oauth-provider-openai-codex"]')),
          };
        `),
        (value) => value.harnessSelected === "true" && value.detailSelected === "true" && value.providerVisible,
      );
    } finally {
      await deleteWebdriverSession(webdriverSessionId);
    }
  }, 180_000);
});
