import { describe, expect, it } from "vitest";

import {
  buildSourceControlPreviewRows,
  findUnknownSourceControlVariables,
  resolveSourceControlTemplate,
} from "../src/lib/sourceControlSettings";

describe("source control settings helpers", () => {
  it("resolves role and agent template variables", () => {
    expect(resolveSourceControlTemplate("Orchestra {role}", { role: "architect", agent: "" })).toBe("Orchestra architect");
    expect(resolveSourceControlTemplate("bot+{agent}@example.com", { role: "", agent: "reviewer" })).toBe("bot+reviewer@example.com");
    expect(resolveSourceControlTemplate("Orchestra {role}", { role: "", agent: "reviewer" })).toBe("Orchestra");
  });

  it("flags unknown variables and computes project-overrides preview precedence", () => {
    expect(findUnknownSourceControlVariables("Name {role} {team} {agent} {worker}")).toEqual(["{team}", "{worker}"]);

    const previewRows = buildSourceControlPreviewRows(
      {
        gitUserNameTemplate: "Global {role}{agent}",
        gitEmailTemplate: "global+{role}{agent}@example.com",
      },
      {
        gitUserNameTemplate: "",
        gitEmailTemplate: "project+{role}{agent}@example.com",
      },
    );

    expect(previewRows[0]).toMatchObject({
      label: "Role preview",
      gitUserName: {
        resolved: "Global architect",
        origin: "global_default",
      },
      gitEmail: {
        resolved: "project+architect@example.com",
        origin: "project_override",
      },
    });
  });
});
