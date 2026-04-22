import { describe, expect, it } from "vitest";

import {
  buildSessionStorageInfo,
  getOrchestraDatabasePath,
  getOrchestraRoot,
  getProjectSessionDir,
  getProjectSlugFromCwd,
  sanitizeSlug,
} from "../src/lib/orchestraPaths";

describe("orchestra session path helpers", () => {
  it("sanitizes project slugs for filesystem use", () => {
    expect(sanitizeSlug(" Orchestra App ")).toBe("orchestra-app");
    expect(sanitizeSlug("QA / Reviewer Role")).toBe("qa-reviewer-role");
    expect(sanitizeSlug("***")).toBe("project");
  });

  it("derives a default project slug from cwd", () => {
    expect(getProjectSlugFromCwd("/home/example-user/workspace/orchestra")).toBe("orchestra");
  });

  it("builds Orchestra-managed session paths under .orchestra", () => {
    const homeDir = "/tmp/orchestra-home";

    expect(getOrchestraRoot(homeDir)).toBe("/tmp/orchestra-home/.orchestra");
    expect(getOrchestraDatabasePath(homeDir)).toBe("/tmp/orchestra-home/.orchestra/orchestra.db");
    expect(getProjectSessionDir(homeDir, "Orchestra App")).toBe(
      "/tmp/orchestra-home/.orchestra/projects/orchestra-app/sessions",
    );

    expect(buildSessionStorageInfo(homeDir, "Orchestra App")).toEqual({
      orchestraRoot: "/tmp/orchestra-home/.orchestra",
      databasePath: "/tmp/orchestra-home/.orchestra/orchestra.db",
      projectRoot: "/tmp/orchestra-home/.orchestra/projects/orchestra-app",
      sessionDir: "/tmp/orchestra-home/.orchestra/projects/orchestra-app/sessions",
      projectSlug: "orchestra-app",
    });
  });
});
