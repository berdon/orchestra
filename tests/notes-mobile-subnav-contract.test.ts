import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const notesPageSource = readFileSync(join(process.cwd(), "src/pages/NotesPage.tsx"), "utf8");

describe("NotesPage mobile header contract", () => {
  it("owns its mobile header instead of reusing the shared settings sub-navigation shell", () => {
    expect(notesPageSource).not.toContain("SettingsMobileSubnavHeader");
    expect(notesPageSource).toContain('data-role="notes-detail-primary-header"');
    expect(notesPageSource).toContain("notes-page__detail-header-sentinel");
    expect(notesPageSource).toContain('data-role="notes-detail-compact-header"');
  });

  it("keeps selection and actions inside the notes header on mobile", () => {
    expect(notesPageSource).toContain('data-role="notes-detail-header-select-control"');
    expect(notesPageSource).toContain('mobileTriggerDataRole="notes-detail-header-actions-trigger"');
    expect(notesPageSource).toContain("mobileHeaderActions");
  });

  it("switches the main note surface between editor and preview instead of rendering both panes together", () => {
    expect(notesPageSource).toContain('data-role={previewVisible ? "notes-preview-surface" : "notes-editor-surface"}');
    expect(notesPageSource).toContain("autoGrow={isMobileViewport}");
    expect(notesPageSource).not.toContain("notes-editor__panes");
  });
});
