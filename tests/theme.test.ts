import { describe, expect, it } from "vitest";

import {
  BUILT_IN_ORCHESTRA_THEMES,
  DEFAULT_ORCHESTRA_THEME_ID,
  applyOrchestraTheme,
  getOrchestraThemeDefinition,
  loadStoredOrchestraTheme,
  storeOrchestraTheme,
  type OrchestraThemeId,
} from "../src/lib/theme";

describe("theme helpers", () => {
  it("exposes the built-in Orchestra themes", () => {
    expect(BUILT_IN_ORCHESTRA_THEMES.map((theme) => theme.id)).toEqual([
      "orchestra-light",
      "orchestra-dark",
      "orchestra-high-contrast",
      "vscode-light-plus",
      "vscode-dark-plus",
      "one-dark-pro",
      "dracula",
      "gruvbox-dark",
      "gruvbox-light",
      "solarized-dark",
      "solarized-light",
      "nord",
      "tokyo-night",
      "catppuccin-mocha",
      "catppuccin-latte",
      "monokai",
    ]);
  });

  it("falls back to the default theme when storage contains an invalid value", () => {
    const storage = {
      getItem: () => "not-a-real-theme",
    } satisfies Pick<Storage, "getItem">;

    expect(loadStoredOrchestraTheme(storage)).toBe(DEFAULT_ORCHESTRA_THEME_ID);
  });

  it("returns the stored theme when it is valid", () => {
    const storage = {
      getItem: () => "orchestra-dark",
    } satisfies Pick<Storage, "getItem">;

    expect(loadStoredOrchestraTheme(storage)).toBe("orchestra-dark");
  });

  it("stores the selected theme id", () => {
    const calls: Array<[string, string]> = [];
    const storage = {
      setItem: (key: string, value: string) => {
        calls.push([key, value]);
      },
    } satisfies Pick<Storage, "setItem">;

    storeOrchestraTheme("orchestra-light", storage);

    expect(calls).toEqual([["orchestra.preferences.theme", "orchestra-light"]]);
  });

  it("applies theme metadata to the document root", () => {
    const themeId: OrchestraThemeId = "orchestra-high-contrast";
    const doc = {
      documentElement: {
        dataset: {},
        style: { colorScheme: "" },
      },
      body: {
        dataset: {},
      },
    } as unknown as Document;

    applyOrchestraTheme(themeId, doc);

    expect(doc.documentElement.dataset.theme).toBe(themeId);
    expect(doc.documentElement.dataset.themeKind).toBe("high-contrast");
    expect(doc.documentElement.style.colorScheme).toBe("dark");
    expect(doc.body.dataset.theme).toBe(themeId);
  });

  it("resolves theme definitions by id", () => {
    expect(getOrchestraThemeDefinition("orchestra-light")).toMatchObject({
      id: "orchestra-light",
      kind: "light",
      colorScheme: "light",
    });
    expect(getOrchestraThemeDefinition("orchestra-dark")).toMatchObject({
      id: "orchestra-dark",
      kind: "dark",
      colorScheme: "dark",
    });
    expect(getOrchestraThemeDefinition("catppuccin-latte")).toMatchObject({
      id: "catppuccin-latte",
      kind: "light",
      colorScheme: "light",
    });
    expect(getOrchestraThemeDefinition("tokyo-night")).toMatchObject({
      id: "tokyo-night",
      kind: "dark",
      colorScheme: "dark",
    });
  });
});
