import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(1_000);
  }

  throw new Error(
    `Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`,
  );
}

function setupRepository(root: string) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "README.md"),
    "# Project secret persistence desktop test\n",
    "utf8",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Desktop E2E"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: root,
    stdio: "ignore",
  });
}

async function openProjectSecrets(sessionId: string, projectName: string) {
  await clickByText(sessionId, "button", "Settings");
  await clickByText(sessionId, "button", "Projects").catch(() => undefined);
  await waitForText(sessionId, "Project catalog");
  await switchProject(sessionId, projectName);
  await waitForSelector(sessionId, '[data-role="project-detail-tab-secrets"]');
  await clickSelector(sessionId, '[data-role="project-detail-tab-secrets"]');
  await waitForSelector(
    sessionId,
    '[data-role="project-detail-tabpanel-secrets"]',
  );
  await waitForSelector(sessionId, '[data-role="project-secrets-status"]');
}

function projectSecretCardSelector(secretKey: string) {
  return `[data-role="project-secret-card"][data-secret-key="${secretKey}"]`;
}

function projectSecretStatusSelector(secretKey: string) {
  return `${projectSecretCardSelector(secretKey)} [data-role="project-secret-status"]`;
}

async function waitForSecretStatus(
  sessionId: string,
  secretKey: string,
  expectedStatus: string,
  forbiddenStatus = "Missing value",
  timeoutMs = 30_000,
) {
  const cardSelector = projectSecretCardSelector(secretKey);
  const statusSelector = projectSecretStatusSelector(secretKey);
  await waitForSelector(sessionId, cardSelector, timeoutMs);
  await waitForCondition(
    async () => executeScript<{ cardText: string | null; statusText: string | null }>(
      sessionId,
      `
        const card = document.querySelector(arguments[0]);
        const status = document.querySelector(arguments[1]);
        return {
          cardText: card ? (card.textContent || "").trim() : null,
          statusText: status ? (status.textContent || "").trim() : null,
        };
      `,
      [cardSelector, statusSelector],
    ),
    (state) => state?.statusText === expectedStatus && !String(state?.cardText ?? "").includes(forbiddenStatus),
    timeoutMs,
  );
}

async function reloadDesktopApp(sessionId: string) {
  await executeScript(sessionId, `window.location.reload(); return true;`);
  await sleep(1_000);
  await ensureReactReady(sessionId);
}

async function waitForAssistantText(
  webdriverSessionId: string,
  runtimeSessionId: string,
  expectedText: string,
  timeoutMs = 180_000,
) {
  await waitForCondition(
    () =>
      invokeCommand<any>(webdriverSessionId, "get_session_record", {
        sessionId: runtimeSessionId,
      }),
    (record) =>
      Array.isArray(record?.events) &&
      record.events.some(
        (event: any) =>
          event?.kind === "assistant" &&
          JSON.stringify(event).includes(expectedText),
      ),
    timeoutMs,
  );
}

async function verifySecretViaAgent(
  webdriverSessionId: string,
  options: {
    agentId: string;
    projectId: string;
    projectSlug: string;
    secretKey: string;
    expectedValue: string;
    outputFile: string;
  },
) {
  rmSync(options.outputFile, { force: true });
  const successToken = "SECRET_MATCH_OK";
  const createdSession = await invokeCommand<{ id: string }>(
    webdriverSessionId,
    "ensure_agent_session",
    {
      agentId: options.agentId,
      projectId: options.projectId,
    },
  );

  await invokeCommand(webdriverSessionId, "send_session_message", {
    sessionId: createdSession.id,
    runId: `secret-verify-${Date.now()}`,
    message: [
      "Verify a saved Orchestra project secret without printing the secret value.",
      `Load the project secret ${options.secretKey} into env var PROJECT_SECRET_UNDER_TEST using the Orchestra get_project_secret tool.`,
      "Then use the bash tool to run this exact command:",
      [
        "python3 - <<'PY'",
        "import os, pathlib",
        `path = pathlib.Path(${JSON.stringify(options.outputFile)})`,
        `expected = ${JSON.stringify(options.expectedValue)}`,
        `success = ${JSON.stringify(`${successToken}\n`)}`,
        `failure = ${JSON.stringify("SECRET_MISMATCH\n")}`,
        "path.write_text(success if os.environ.get('PROJECT_SECRET_UNDER_TEST') == expected else failure, encoding='utf-8')",
        "PY",
      ].join("\n"),
      `If the file contains ${successToken}, reply with exactly ${successToken} and nothing else.`,
      "If verification fails, briefly explain the failure without echoing the secret value.",
    ].join("\n\n"),
  });

  await waitForAssistantText(
    webdriverSessionId,
    createdSession.id,
    successToken,
    240_000,
  );
  await waitForCondition(
    async () =>
      existsSync(options.outputFile)
        ? readFileSync(options.outputFile, "utf8")
        : "",
    (contents) => contents === `${successToken}\n`,
    240_000,
  );
  await invokeCommand(webdriverSessionId, "unsubscribe_session", {
    sessionId: createdSession.id,
  }).catch(() => undefined);
}

type ProjectSecretStoreDebugStats = {
  availabilityCalls: number;
  probeAccessCalls: number;
  getValueCalls: number;
  setValueCalls: number;
  deleteValueCalls: number;
};

async function getProjectSecretStoreStats(
  sessionId: string,
  projectSlug: string,
) {
  const state = await invokeCommand<any>(sessionId, "get_project_secrets", {
    projectSlug,
  });
  return (state?.debugStats ?? {
    availabilityCalls: 0,
    probeAccessCalls: 0,
    getValueCalls: 0,
    setValueCalls: 0,
    deleteValueCalls: 0,
  }) as ProjectSecretStoreDebugStats;
}

describe("desktop project secret persistence", () => {
  it.skipIf(!isDesktopE2E)(
    "persists created and rotated secret values from Settings and verifies later agent retrieval in Podman",
    async () => {
      expect(testHome).toBeTruthy();

      const projectName = "Project Secret Persistence";
      const secretKey = "DESKTOP_SECRET_PERSISTENCE";
      const initialDescription = "Initial UI secret";
      const rotatedDescription = "Rotated UI secret";
      const initialValue = "desktop-secret-alpha-272";
      const rotatedValue = "desktop-secret-beta-272";
      const repositoryRoot = join(
        testHome!,
        "workspace",
        "project-secret-persistence-repo",
        "repository",
      );
      const createVerificationFile = join(
        testHome!,
        "workspace",
        "project-secret-create-verification.txt",
      );
      const rotateVerificationFile = join(
        testHome!,
        "workspace",
        "project-secret-rotate-verification.txt",
      );

      setupRepository(repositoryRoot);
      rmSync(createVerificationFile, { force: true });
      rmSync(rotateVerificationFile, { force: true });

      const webdriverSessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(webdriverSessionId);

        await createProjectViaSettings(
          webdriverSessionId,
          projectName,
          "Desktop E2E project-secret persistence regression.",
        );
        await addRepositoryViaSettings(webdriverSessionId, {
          name: "Project Secret Persistence Repo",
          path: repositoryRoot,
          defaultBranch: "main",
          makeDefault: true,
        });

        const project = await waitForCondition(
          () =>
            invokeCommand<Array<{ id: string; slug: string; name: string }>>(
              webdriverSessionId,
              "list_projects",
            ),
          (projects) => projects.some((entry) => entry.name === projectName),
        ).then(
          (projects) =>
            projects.find((entry) => entry.name === projectName) ?? null,
        );
        expect(project).toBeTruthy();

        const agent = await invokeCommand<{ id: string; slug: string }>(
          webdriverSessionId,
          "create_agent",
          {
            input: {
              name: "Project Secret Verification Agent",
              description:
                "Loads saved project secrets and verifies them without printing values.",
              systemPrompt: [
                "You are a deterministic Orchestra agent used for desktop project-secret regression coverage.",
                "When asked to verify a project secret, use the Orchestra get_project_secret tool first, then use bash exactly as requested.",
                "Never print or echo the secret value itself.",
                "If verification succeeds, reply with the exact success token requested by the user and nothing else.",
              ].join(" "),
              provider: "openai-codex",
              model: "gpt-5.3-codex-spark",
              thinkingLevel: "off",
              scope: "project",
              projectId: project!.id,
              policyIds: ["policy-supervisor"],
              directPermissions: ["projects.secrets.use"],
            },
          },
        );
        expect(agent.id).toBeTruthy();

        await openProjectSecrets(webdriverSessionId, projectName);
        await waitForText(webdriverSessionId, "Available");
        await setInputValue(
          webdriverSessionId,
          '[data-role="project-secret-key"]',
          secretKey,
        );
        await setInputValue(
          webdriverSessionId,
          '[data-role="project-secret-description"]',
          initialDescription,
        );
        await setInputValue(
          webdriverSessionId,
          '[data-role="project-secret-value"]',
          initialValue,
        );
        await clickSelector(
          webdriverSessionId,
          '[data-role="save-project-secret"]',
        );
        await waitForText(webdriverSessionId, secretKey);
        await waitForText(webdriverSessionId, initialDescription);
        await waitForText(webdriverSessionId, "Ready");

        await waitForCondition(
          () =>
            invokeCommand<any>(webdriverSessionId, "get_project_secrets", {
              projectSlug: project!.slug,
            }),
          (state) =>
            state?.availability?.status === "available" &&
            Array.isArray(state?.secrets) &&
            state.secrets.some(
              (entry: any) =>
                entry.secretKey === secretKey &&
                entry.description === initialDescription &&
                entry.valueState === "ready",
            ),
        );

        await reloadDesktopApp(webdriverSessionId);
        await openProjectSecrets(webdriverSessionId, projectName);
        await waitForText(webdriverSessionId, initialDescription);
        await verifySecretViaAgent(webdriverSessionId, {
          agentId: agent.id,
          projectId: project!.id,
          projectSlug: project!.slug,
          secretKey,
          expectedValue: initialValue,
          outputFile: createVerificationFile,
        });

        await openProjectSecrets(webdriverSessionId, projectName);
        await clickByText(webdriverSessionId, "button", "Edit / rotate");
        await waitForSelector(
          webdriverSessionId,
          '[data-role="project-secret-key"][disabled]',
        );
        await setInputValue(
          webdriverSessionId,
          '[data-role="project-secret-description"]',
          rotatedDescription,
        );
        await setInputValue(
          webdriverSessionId,
          '[data-role="project-secret-value"]',
          rotatedValue,
        );
        await clickSelector(
          webdriverSessionId,
          '[data-role="save-project-secret"]',
        );
        await waitForText(webdriverSessionId, rotatedDescription);

        await waitForCondition(
          () =>
            invokeCommand<any>(webdriverSessionId, "get_project_secrets", {
              projectSlug: project!.slug,
            }),
          (state) =>
            Array.isArray(state?.secrets) &&
            state.secrets.some(
              (entry: any) =>
                entry.secretKey === secretKey &&
                entry.description === rotatedDescription &&
                entry.valueState === "ready",
            ),
        );

        await reloadDesktopApp(webdriverSessionId);
        await openProjectSecrets(webdriverSessionId, projectName);
        await waitForText(webdriverSessionId, rotatedDescription);
        await verifySecretViaAgent(webdriverSessionId, {
          agentId: agent.id,
          projectId: project!.id,
          projectSlug: project!.slug,
          secretKey,
          expectedValue: rotatedValue,
          outputFile: rotateVerificationFile,
        });

        expect(readFileSync(createVerificationFile, "utf8")).toBe(
          "SECRET_MATCH_OK\n",
        );
        expect(readFileSync(rotateVerificationFile, "utf8")).toBe(
          "SECRET_MATCH_OK\n",
        );
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
        rmSync(createVerificationFile, { force: true });
        rmSync(rotateVerificationFile, { force: true });
      }
    },
    420_000,
  );

  it.skipIf(!isDesktopE2E)(
    "loads the Secrets settings tab without per-secret raw store lookups while explicit secret use still reads the value",
    async () => {
      expect(testHome).toBeTruthy();

      const projectName = "Project Secret Load Regression";
      const repositoryRoot = join(
        testHome!,
        "workspace",
        "project-secret-load-repo",
        "repository",
      );
      const verificationFile = join(
        testHome!,
        "workspace",
        "project-secret-load-verification.txt",
      );
      const seededSecrets = Array.from({ length: 6 }, (_, index) => ({
        secretKey: `DESKTOP_SECRET_LOAD_${index + 1}`,
        description: `Seeded desktop secret ${index + 1}`,
        value: `desktop-secret-load-${index + 1}`,
      }));

      setupRepository(repositoryRoot);
      rmSync(verificationFile, { force: true });

      const webdriverSessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(webdriverSessionId);

        await createProjectViaSettings(
          webdriverSessionId,
          projectName,
          "Desktop E2E project-secret load regression coverage.",
        );
        await addRepositoryViaSettings(webdriverSessionId, {
          name: "Project Secret Load Repo",
          path: repositoryRoot,
          defaultBranch: "main",
          makeDefault: true,
        });

        const project = await waitForCondition(
          () =>
            invokeCommand<Array<{ id: string; slug: string; name: string }>>(
              webdriverSessionId,
              "list_projects",
            ),
          (projects) => projects.some((entry) => entry.name === projectName),
        ).then(
          (projects) =>
            projects.find((entry) => entry.name === projectName) ?? null,
        );
        expect(project).toBeTruthy();

        const agent = await invokeCommand<{ id: string }>(
          webdriverSessionId,
          "create_agent",
          {
            input: {
              name: "Project Secret Load Verification Agent",
              description:
                "Loads one saved project secret to verify the explicit use path still works.",
              systemPrompt: [
                "You are a deterministic Orchestra agent used for desktop project-secret loading regression coverage.",
                "When asked to verify a project secret, use the Orchestra get_project_secret tool first, then use bash exactly as requested.",
                "Never print or echo the secret value itself.",
                "If verification succeeds, reply with the exact success token requested by the user and nothing else.",
              ].join(" "),
              provider: "openai-codex",
              model: "gpt-5.3-codex-spark",
              thinkingLevel: "off",
              scope: "project",
              projectId: project!.id,
              policyIds: ["policy-supervisor"],
              directPermissions: ["projects.secrets.use"],
            },
          },
        );
        expect(agent.id).toBeTruthy();

        for (const secret of seededSecrets) {
          await invokeCommand(webdriverSessionId, "create_project_secret", {
            projectSlug: project!.slug,
            input: secret,
          });
        }

        const baselineStats = await getProjectSecretStoreStats(
          webdriverSessionId,
          project!.slug,
        );
        await openProjectSecrets(webdriverSessionId, projectName);
        await waitForText(webdriverSessionId, seededSecrets[0].secretKey);
        await waitForText(
          webdriverSessionId,
          seededSecrets[seededSecrets.length - 1].secretKey,
        );

        const loadStats = await getProjectSecretStoreStats(
          webdriverSessionId,
          project!.slug,
        );
        expect(loadStats.getValueCalls - baselineStats.getValueCalls).toBe(0);
        expect(
          loadStats.probeAccessCalls - baselineStats.probeAccessCalls,
        ).toBeLessThanOrEqual(2);
        expect(
          loadStats.availabilityCalls - baselineStats.availabilityCalls,
        ).toBeLessThanOrEqual(2);

        await verifySecretViaAgent(webdriverSessionId, {
          agentId: agent.id,
          projectId: project!.id,
          projectSlug: project!.slug,
          secretKey: seededSecrets[0].secretKey,
          expectedValue: seededSecrets[0].value,
          outputFile: verificationFile,
        });

        const explicitLoadStats = await getProjectSecretStoreStats(
          webdriverSessionId,
          project!.slug,
        );
        expect(
          explicitLoadStats.getValueCalls - loadStats.getValueCalls,
        ).toBeGreaterThan(0);
        expect(readFileSync(verificationFile, "utf8")).toBe(
          "SECRET_MATCH_OK\n",
        );
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
        rmSync(verificationFile, { force: true });
      }
    },
    420_000,
  );
});
