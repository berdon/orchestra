import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  selectValue,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop theme selection", () => {
  it.skipIf(!isDesktopE2E)("surfaces the expanded built-in theme list and applies a new preset", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "[role=tab]", "General");
      await waitForText(sessionId, "Theme");

      const options = await executeScript<Array<{ value: string; label: string }>>(sessionId, `
        const select = document.querySelector('[data-role="theme-select"]');
        if (!(select instanceof HTMLSelectElement)) return [];
        return Array.from(select.options).map((option) => ({ value: option.value, label: option.label }));
      `);

      expect(options.some((option) => option.value === "dracula")).toBe(true);
      expect(options.some((option) => option.value === "vscode-dark-plus")).toBe(true);
      expect(options.some((option) => option.value === "catppuccin-latte")).toBe(true);
      expect(options.some((option) => option.value === "tokyo-night")).toBe(true);

      await selectValue(sessionId, '[data-role="theme-select"]', "dracula");

      const applied = await executeScript<{ theme: string | null; kind: string | null; stored: string | null }>(sessionId, `
        const root = document.documentElement;
        return {
          theme: root.dataset.theme ?? null,
          kind: root.dataset.themeKind ?? null,
          stored: window.localStorage.getItem('orchestra.preferences.theme'),
        };
      `);

      expect(applied.theme).toBe("dracula");
      expect(applied.kind).toBe("dark");
      expect(applied.stored).toBe("dracula");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
