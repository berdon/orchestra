import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const skillsPanelSource = readFileSync(join(process.cwd(), "src/settings/SkillsPanel.tsx"), "utf8");

describe("SkillsPanel mobile sub-navigation contract", () => {
  it("opts the skills sidebar into the shared mobile sub-navigation and standard list classes", () => {
    expect(skillsPanelSource).toContain('navigationClassName="skills-nav-panel settings-mobile-subnav-panel"');
    expect(skillsPanelSource).toContain('className="task-list skills-list settings-mobile-subnav-list"');
    expect(skillsPanelSource).toContain('task-list-link task-list-link--active skills-list-item');
  });

  it("marks redundant desktop action clusters so mobile CSS can hide them", () => {
    const redundantActionClassCount = skillsPanelSource.match(/settings-mobile-subnav-redundant-actions/g)?.length ?? 0;
    expect(redundantActionClassCount).toBeGreaterThanOrEqual(3);
  });
});
