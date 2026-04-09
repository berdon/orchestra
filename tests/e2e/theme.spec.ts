import { expect, test } from "@playwright/test";

const THEME_CASES = [
  {
    id: "orchestra-light",
    kind: "light",
    colorScheme: "light",
    appBackground: "#f6f8fc",
  },
  {
    id: "orchestra-dark",
    kind: "dark",
    colorScheme: "dark",
    appBackground: "#1e1e1e",
  },
  {
    id: "orchestra-high-contrast",
    kind: "high-contrast",
    colorScheme: "dark",
    appBackground: "#000000",
  },
] as const;

for (const themeCase of THEME_CASES) {
  test(`applies ${themeCase.id} from stored preferences`, async ({ page }) => {
    await page.addInitScript((themeId: string) => {
      window.localStorage.clear();
      window.localStorage.setItem("orchestra.preferences.theme", themeId);
    }, themeCase.id);

    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("data-theme", themeCase.id);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", themeCase.id);

    const themeState = await page.evaluate(() => {
      const root = document.documentElement;
      const shell = document.querySelector(".app-shell") as HTMLElement | null;
      const styles = getComputedStyle(root);
      return {
        rootTheme: root.dataset.theme ?? null,
        rootThemeKind: root.dataset.themeKind ?? null,
        rootColorScheme: root.style.colorScheme,
        appBackground: styles.getPropertyValue("--color-app-background").trim(),
        shellTheme: shell?.dataset.theme ?? null,
        shellThemeKind: shell?.dataset.themeKind ?? null,
      };
    });

    expect(themeState.rootTheme).toBe(themeCase.id);
    expect(themeState.rootThemeKind).toBe(themeCase.kind);
    expect(themeState.rootColorScheme).toBe(themeCase.colorScheme);
    expect(themeState.appBackground).toBe(themeCase.appBackground);
    expect(themeState.shellTheme).toBe(themeCase.id);
    expect(themeState.shellThemeKind).toBe(themeCase.kind);
  });
}
