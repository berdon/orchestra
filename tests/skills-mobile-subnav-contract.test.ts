import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const skillsPanelSource = readFileSync(join(process.cwd(), "src/settings/SkillsPanel.tsx"), "utf8");

describe("SkillsPanel mobile sub-navigation contract", () => {
  it("opts the skills sidebar into the shared mobile sub-navigation classes", () => {
    expect(skillsPanelSource).toContain('navigationClassName="skills-nav-panel settings-mobile-subnav-panel"');
    expect(skillsPanelSource).toContain('className="skills-list settings-mobile-subnav-list"');
  });

  it("marks redundant desktop action clusters so mobile CSS can hide them", () => {
    const redundantActionClassCount = skillsPanelSource.match(/settings-mobile-subnav-redundant-actions/g)?.length ?? 0;
    expect(redundantActionClassCount).toBeGreaterThanOrEqual(3);
  });
});
