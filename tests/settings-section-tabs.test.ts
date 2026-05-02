import { describe, expect, it } from "vitest";

import { resolveVisibleSettingsSectionTab } from "../src/components/SettingsSectionTabs";

describe("resolveVisibleSettingsSectionTab", () => {
  it("keeps the current tab when it remains visible", () => {
    expect(resolveVisibleSettingsSectionTab([
      { id: "appearance" },
      { id: "notifications" },
      { id: "logs" },
    ], "notifications", "appearance")).toBe("notifications");
  });

  it("falls back to the initial tab when the active tab disappears", () => {
    expect(resolveVisibleSettingsSectionTab([
      { id: "appearance" },
      { id: "notifications", hidden: true },
      { id: "logs" },
    ], "notifications", "logs")).toBe("logs");
  });

  it("falls back to the first visible tab when the initial tab is also hidden", () => {
    expect(resolveVisibleSettingsSectionTab([
      { id: "appearance" },
      { id: "notifications", hidden: true },
      { id: "logs" },
    ], "notifications", "notifications")).toBe("appearance");
  });

  it("returns an empty string when no tabs remain visible", () => {
    expect(resolveVisibleSettingsSectionTab([
      { id: "appearance", hidden: true },
      { id: "notifications", hidden: true },
    ], "notifications", "appearance")).toBe("");
  });
});
