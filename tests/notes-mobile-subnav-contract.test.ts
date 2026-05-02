import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");

describe("NotesPage mobile sub-navigation contract", () => {
  it("uses the shared mobile sub-navigation header and hides the desktop sidebar on mobile", () => {
    expect(notesPageSource).toContain("<SettingsMobileSubnavHeader");
    expect(notesPageSource).toContain('dataRolePrefix="notes"');
    expect(notesPageSource).toContain('navigationClassName="notes-page__navigation settings-mobile-subnav-panel"');
    expect(notesPageSource).toContain('className="notes-page__nav-tree settings-mobile-subnav-list"');
  });

  it("uses a compact mobile header for notes so the selector does not spend extra vertical space", () => {
    expect(notesPageSource).toContain("selectLabel={null}");
  });

  it("marks redundant desktop actions so the mobile header becomes the primary action surface", () => {
    const redundantActionClassCount = notesPageSource.match(/settings-mobile-subnav-redundant-actions/g)?.length ?? 0;
    expect(redundantActionClassCount).toBeGreaterThanOrEqual(2);
  });
});
