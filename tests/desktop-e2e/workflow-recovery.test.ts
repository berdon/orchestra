import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createRoleViaSettings,
  openRoleOperations,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop workflow recovery", () => {
  it.skipIf(!isDesktopE2E)("shows the role reset action in role operations", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const suffix = Date.now().toString(36);
      const projectName = `Role Reset Project ${suffix}`;
      const repositoryName = `Role Reset Repo ${suffix}`;
      const roleName = `Reset Worker ${suffix}`;
      const repositoryRoot = join(testHome!, "workspace", `role-reset-repo-${suffix}`, "repository");

      await createProjectViaSettings(sessionId, projectName, "Reset role assignments while preserving queued workflow work.");
      await addRepositoryViaSettings(sessionId, {
        name: repositoryName,
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, projectName);
      await createRoleViaSettings(sessionId, {
        name: roleName,
        capacity: "1",
        description: "Worker used for role reset regression coverage.",
      });

      await openRoleOperations(sessionId, roleName);
      await waitForText(sessionId, roleName);
      await waitForText(sessionId, "Reset assignments");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
