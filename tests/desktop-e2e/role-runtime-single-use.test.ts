import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  setFieldByLabel,
  sleep,
} from "./driver";
import {
  createProjectViaSettings,
  createRoleViaSettings,
  dispatchRoleQueueViaUi,
  openRoleOperations,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForRoleInstance(
  sessionId: string,
  roleId: string,
  predicate: (instances: any[]) => any | undefined,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await invokeCommand<any>(sessionId, "get_role_operations", { roleId });
    const match = predicate(detail.instances ?? []);
    if (match) {
      return { detail, instance: match };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for role instance on ${roleId}`);
}

describe("desktop single-use role runtimes", () => {
  it.skipIf(!isDesktopE2E)("creates a fresh role instance/session/worktree for each dispatched work item", async () => {
    expect(testHome).toBeTruthy();

    const orchestraProjectsRoot = join(testHome!, ".orchestra", "projects");

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Single Use Role Project", "Desktop regression for single-use role runtimes.");
      await switchProject(sessionId, "Single Use Role Project");
      await createRoleViaSettings(sessionId, {
        name: "Single Use Worker",
        capacity: "1",
        description: "Transient single-use worker for regression coverage.",
      });

      const roles = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_roles", { includeArchived: false });
      const role = roles.find((entry) => entry.name === "Single Use Worker");
      expect(role).toBeTruthy();

      await openRoleOperations(sessionId, "Single Use Worker");
      await setFieldByLabel(sessionId, 'Title', 'First single-use work item');
      await setFieldByLabel(sessionId, 'Summary', 'Dispatch the first single-use runtime.');
      await setFieldByLabel(sessionId, 'Entry prompt', 'First work item');
      await clickByText(sessionId, 'button', 'Enqueue work');
      await dispatchRoleQueueViaUi(sessionId);

      const firstRuntime = await waitForRoleInstance(
        sessionId,
        role!.id,
        (instances) => instances.find((entry: any) => entry.status === "running" && entry.sessionId && entry.worktreePath),
        60_000,
      );
      const firstInstance = firstRuntime.instance;
      const firstSession = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: firstInstance.sessionId });
      expect(firstSession).toBeTruthy();
      expect(firstInstance.worktreePath).toContain(orchestraProjectsRoot);
      expect(existsSync(firstInstance.worktreePath ?? "")).toBe(true);

      await invokeCommand(sessionId, "release_role_instance", { instanceId: firstInstance.id, outcome: "success" });
      await waitForRoleInstance(
        sessionId,
        role!.id,
        (instances) => instances.find((entry: any) => entry.id === firstInstance.id && entry.status === "completed"),
        30_000,
      );

      await setFieldByLabel(sessionId, 'Title', 'Second single-use work item');
      await setFieldByLabel(sessionId, 'Summary', 'Dispatch the second single-use runtime.');
      await setFieldByLabel(sessionId, 'Entry prompt', 'Second work item');
      await clickByText(sessionId, 'button', 'Enqueue work');
      await dispatchRoleQueueViaUi(sessionId);

      const secondRuntime = await waitForRoleInstance(
        sessionId,
        role!.id,
        (instances) => instances.find((entry: any) => entry.status === "running" && entry.sessionId && entry.worktreePath && entry.id !== firstInstance.id),
        60_000,
      );
      const secondInstance = secondRuntime.instance;
      const secondSession = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: secondInstance.sessionId });
      expect(secondSession).toBeTruthy();
      expect(secondInstance.worktreePath).toContain(orchestraProjectsRoot);
      expect(existsSync(secondInstance.worktreePath ?? "")).toBe(true);

      expect(secondInstance.sessionId).not.toBe(firstInstance.sessionId);
      expect(secondInstance.id).not.toBe(firstInstance.id);
      expect(secondInstance.worktreePath).not.toBe(firstInstance.worktreePath);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
