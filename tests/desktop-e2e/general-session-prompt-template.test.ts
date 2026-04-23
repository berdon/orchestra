import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  setInputValue,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop general, harness, and prompting settings", () => {
  it.skipIf(!isDesktopE2E)("saves harness runtime extensions, exposes source control tokens, and resets the prompting template draft to the updated default copy", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "Harness");
      await waitForSelector(sessionId, '[data-role="pi-runtime-extensions"]');

      await setInputValue(sessionId, '[data-role="pi-runtime-extensions"]', 'npm:pi-example\n./extensions/local-extra.ts\n./extensions/local-extra.ts');
      await clickSelector(sessionId, '[data-role="save-pi-runtime-extensions"]');

      const piRuntimeSettings = await invokeCommand<{ extraExtensions: string[] }>(sessionId, 'get_pi_runtime_settings');
      expect(piRuntimeSettings.extraExtensions).toEqual(['npm:pi-example', './extensions/local-extra.ts']);

      const createdSession = await invokeCommand<{ id: string }>(sessionId, 'create_session', {
        title: 'Extension runtime verification',
        projectSlug: 'orchestra',
      });
      await invokeCommand(sessionId, 'subscribe_session', { sessionId: createdSession.id });
      const logs = await invokeCommand<Array<{ target: string; message: string }>>(sessionId, 'get_logs');
      const spawnLog = logs.find((entry) => entry.target === 'sessions.runtime.spawn.request' && entry.message.includes(createdSession.id));
      expect(spawnLog?.message).toContain('extra_extensions=npm:pi-example, ./extensions/local-extra.ts');

      await clickByText(sessionId, '[role="tab"]', 'Prompting');
      await waitForSelector(sessionId, '[data-role="session-prompt-template"]');
      await waitForSelector(sessionId, '[data-role="session-prompt-token-table"]');

      const promptTokenTableText = await executeScript<string>(sessionId, `
        const table = document.querySelector('[data-role="session-prompt-token-table"]');
        return table instanceof HTMLElement ? table.innerText : '';
      `);
      expect(promptTokenTableText).toContain('{SOURCE_CONTROL.CONTEXT}');
      expect(promptTokenTableText).toContain('{SOURCE_CONTROL.GIT.EMAIL}');

      await setInputValue(sessionId, '[data-role="session-prompt-template"]', 'Task {TASK.ID}');
      await clickSelector(sessionId, '[data-role="save-session-prompt-template"]');
      await clickSelector(sessionId, '[data-role="reset-session-prompt-template"]');

      let templateValue = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        templateValue = await executeScript<string>(sessionId, `
          const textarea = document.querySelector('[data-role="session-prompt-template"]');
          return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
        `);
        if (templateValue.includes('You are an agent working inside Orchestra on task {TASK.NUMBER} — {TASK.NAME}.')) {
          break;
        }
        await sleep(250);
      }

      expect(templateValue).toContain('You are an agent working inside Orchestra on task {TASK.NUMBER} — {TASK.NAME}.');
      expect(templateValue).toContain('{SOURCE_CONTROL.CONTEXT}');
      expect(templateValue).toContain('As you do work - periodically comment on tasks to give an update on what you’re doing.');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
