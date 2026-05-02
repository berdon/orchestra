import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  setWindowRect,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;
const FILE_WRITE_TIMEOUT_MS = 10_000;

function resetSkillsFixture(homePath: string) {
  rmSync(join(homePath, ".orchestra-dev", "skills"), { force: true, recursive: true });
  rmSync(join(homePath, ".orchestra-dev", "orchestra.db"), { force: true });
  rmSync(join(homePath, ".orchestra-dev", "orchestra.db-shm"), { force: true });
  rmSync(join(homePath, ".orchestra-dev", "orchestra.db-wal"), { force: true });
  rmSync(join(homePath, ".agents", "skills"), { force: true, recursive: true });

  mkdirSync(join(homePath, ".agents", "skills", "external-readonly"), { recursive: true });
  writeFileSync(
    join(homePath, ".agents", "skills", "external-readonly", "SKILL.md"),
    "# External readonly\n\nRead only external skill body.\n",
  );

  mkdirSync(join(homePath, ".agents", "skills", "missing-skill"), { recursive: true });
  writeFileSync(
    join(homePath, ".agents", "skills", "missing-skill", "SKILL.md"),
    "# Missing skill\n\nThis external skill will disappear after refresh.\n",
  );

  mkdirSync(join(homePath, ".agents", "skills", "bad_slug"), { recursive: true });
  writeFileSync(
    join(homePath, ".agents", "skills", "bad_slug", "SKILL.md"),
    "# Invalid skill\n\nThis directory name is invalid for managed skills.\n",
  );
}

async function bodyText(sessionId: string) {
  return executeScript<string>(sessionId, "return document.body ? document.body.innerText : ''; ");
}

describe("desktop skills settings", () => {
  it.skipIf(!isDesktopE2E)("keeps Skills reachable from the mobile navigation flow", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await setWindowRect(sessionId, { width: 390, height: 844 });
      await expect.poll(async () => executeScript<number>(sessionId, "return window.innerWidth;")).toBeLessThanOrEqual(900);

      await clickSelector(sessionId, '[data-role="toggle-mobile-navigation"]');
      await waitForSelector(sessionId, '[data-role="mobile-navigation-sheet"]');
      await clickByText(sessionId, 'button', 'Settings');

      await waitForSelector(sessionId, '[data-role="settings-sections-subnav"]');
      await expect.poll(async () => executeScript(sessionId, `
        const sheet = document.querySelector('[data-role="mobile-navigation-sheet"]');
        const skillsTab = document.querySelector('[data-role="settings-tab-skills"]');
        return {
          navOpen: Boolean(sheet),
          skillsVisible: skillsTab instanceof HTMLElement && skillsTab.offsetParent !== null,
        };
      `)).toEqual({ navOpen: true, skillsVisible: true });

      await clickSelector(sessionId, '[data-role="settings-tab-skills"]');
      await expect.poll(async () => executeScript<boolean>(sessionId, "return Boolean(document.querySelector('[data-role=\"mobile-navigation-sheet\"]')); ")).toBe(false);
      await waitForSelector(sessionId, '[data-role="skill-mobile-subnav-shell"]');
    } finally {
      await deleteWebdriverSession(sessionId);
      await sleep(250);
    }
  }, 120_000);

  it.skipIf(!isDesktopE2E)("uses the mobile sub-navigation header and action menu on the skills page", async () => {
    expect(testHome).toBeTruthy();
    resetSkillsFixture(testHome!);

    const localSkillPath = join(testHome!, ".orchestra-dev", "skills", "mobile-nav-regression-skill.md");

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await executeScript(sessionId, "window.confirm = () => true;");
      await setWindowRect(sessionId, { width: 390, height: 844 });
      await expect.poll(async () => executeScript<number>(sessionId, "return window.innerWidth;")).toBeLessThanOrEqual(900);

      await clickSelector(sessionId, '[data-role="toggle-mobile-navigation"]');
      await waitForSelector(sessionId, '[data-role="mobile-navigation-sheet"]');
      await clickByText(sessionId, 'button', 'Settings');
      await waitForSelector(sessionId, '[data-role="settings-sections-subnav"]');
      await clickSelector(sessionId, '[data-role="settings-tab-skills"]');
      await waitForSelector(sessionId, '[data-role="skill-mobile-subnav-shell"]');

      await expect.poll(async () => executeScript(sessionId, `
        const visible = (selector) => {
          const element = document.querySelector(selector);
          return element instanceof HTMLElement && element.offsetParent !== null;
        };
        return {
          mobileShellVisible: visible('[data-role="skill-mobile-subnav-shell"]'),
          menuTriggerVisible: visible('[data-role="skill-mobile-subnav-menu-trigger"]'),
          navPanelVisible: visible('.skills-nav-panel.settings-mobile-subnav-panel'),
          skillsListVisible: visible('.skills-list.settings-mobile-subnav-list'),
          refreshVisible: visible('[data-role="refresh-external-skills"]'),
          newSkillVisible: visible('[data-role="new-skill"]'),
        };
      `)).toEqual({
        mobileShellVisible: true,
        menuTriggerVisible: true,
        navPanelVisible: false,
        skillsListVisible: false,
        refreshVisible: false,
        newSkillVisible: false,
      });

      await clickSelector(sessionId, '[data-role="skill-mobile-subnav-menu-trigger"]');
      await clickByText(sessionId, '.task-action-menu__dropdown button', 'New local skill');
      await waitForSelector(sessionId, '[data-role="skill-name"]');
      await setInputValue(sessionId, '[data-role="skill-name"]', 'Mobile Nav Regression Skill');
      await setInputValue(sessionId, '[data-role="skill-markdown-body"]', '# Mobile Nav Regression Skill\n\nCreated from the mobile action menu.\n');

      await expect.poll(async () => executeScript(sessionId, `
        const saveButton = document.querySelector('[data-role="save-skill"]');
        return saveButton instanceof HTMLElement && saveButton.offsetParent !== null;
      `)).toBe(false);

      await clickSelector(sessionId, '[data-role="skill-mobile-subnav-menu-trigger"]');
      await clickByText(sessionId, '.task-action-menu__dropdown button', 'Create skill');
      await expect.poll(() => existsSync(localSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(true);
      await waitForText(sessionId, 'Mobile Nav Regression Skill');
    } finally {
      await deleteWebdriverSession(sessionId);
      await sleep(250);
    }
  }, 120_000);

  it.skipIf(!isDesktopE2E)("manages local skills and renders external source and status details", async () => {
    expect(testHome).toBeTruthy();
    resetSkillsFixture(testHome!);

    const localSkillPath = join(testHome!, ".orchestra-dev", "skills", "local-catalog-skill.md");
    const renamedLocalSkillPath = join(testHome!, ".orchestra-dev", "skills", "local-catalog-skill-renamed.md");
    const shadowLocalSkillPath = join(testHome!, ".orchestra-dev", "skills", "external-readonly.md");

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await executeScript(sessionId, "window.confirm = () => true;");

      await clickByText(sessionId, "button", "Settings");
      await waitForSelector(sessionId, '[data-role="settings-tab-skills"]');
      await clickByText(sessionId, '[role="tab"]', "Skills");
      await waitForText(sessionId, "Managed skills catalog");

      await clickSelector(sessionId, '[data-role="refresh-external-skills"]');
      await waitForText(sessionId, "external-readonly");
      await waitForText(sessionId, "bad_slug");
      await waitForText(sessionId, "External ~/.agents/skills are now part of the managed catalog");

      await clickByText(sessionId, '[data-role="skills-list"] button', "external-readonly");
      await waitForText(sessionId, "Read-only external skill");
      await waitForText(sessionId, "Discovery paths");
      await waitForText(sessionId, "Relative source");
      await clickSelector(sessionId, '[data-role="skill-detail-tab-preview"]');
      await waitForText(sessionId, "Read only external skill body.");
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');
      await waitForText(sessionId, "No bindings yet.");

      await clickSelector(sessionId, '[data-role="new-skill"]');
      await setInputValue(sessionId, '[data-role="skill-name"]', 'Local Catalog Skill');
      await setInputValue(sessionId, '[data-role="skill-markdown-body"]', '# Title\n\nLocal catalog skill summary.\n');
      await waitForText(sessionId, 'Will derive local-catalog-skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-preview"]');
      await waitForText(sessionId, 'Local catalog skill summary.');
      await clickSelector(sessionId, '[data-role="save-skill"]');

      await expect.poll(() => existsSync(localSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(true);
      await waitForText(sessionId, 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');

      await setInputValue(sessionId, '[data-role="skill-project-search"]', 'orchestra');
      await clickByText(sessionId, 'button', 'Add Orchestra');
      await setInputValue(sessionId, '[data-role="skill-role-search"]', 'senior developer');
      await clickByText(sessionId, 'button', 'Add Senior Developer');
      await setInputValue(sessionId, '[data-role="skill-agent-search"]', 'supervisor');
      await clickByText(sessionId, 'button', 'Add Supervisor');
      await setInputValue(sessionId, '[data-role="skill-workflow-search"]', 'development');
      await clickByText(sessionId, 'button', 'Add Development');
      await clickSelector(sessionId, '[data-role="add-lane-binding"]');
      await setInputValue(sessionId, '[data-role="lane-binding-workflow-0"]', 'workflow-development');
      await setInputValue(sessionId, '[data-role="lane-binding-lane-0"]', 'lane-development-implement');
      await clickSelector(sessionId, '[data-role="save-skill-bindings"]');
      await waitForText(sessionId, '5 bindings');
      await waitForText(sessionId, 'Project · Orchestra');
      await waitForText(sessionId, 'Role · Senior Developer');
      await waitForText(sessionId, 'Agent · Supervisor');
      await waitForText(sessionId, 'Workflow · Development');
      await waitForText(sessionId, 'Workflow lane · Development → Implement');

      await clickByText(sessionId, '[data-role="skills-list"] button', 'external-readonly');
      await clickByText(sessionId, '[data-role="skills-list"] button', 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');
      await waitForText(sessionId, '5 bindings');
      await waitForText(sessionId, 'Project · Orchestra');

      await clickSelector(sessionId, '[data-role="settings-tab-agents"]');
      await waitForText(sessionId, 'Agent library');
      await clickByText(sessionId, '[aria-label="Agents"] a', 'Supervisor');
      await clickSelector(sessionId, '[data-role="agent-detail-tab-skills"]');
      await waitForText(sessionId, 'Linked skills');
      await waitForText(sessionId, 'Local Catalog Skill');
      await clickByText(sessionId, 'button', 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');
      await waitForText(sessionId, 'Scope bindings');

      await clickSelector(sessionId, '[data-role="settings-tab-roles"]');
      await waitForText(sessionId, 'Role library');
      await clickByText(sessionId, '[aria-label="Roles"] a', 'Senior Developer');
      await clickSelector(sessionId, '[data-role="role-detail-tab-skills"]');
      await waitForText(sessionId, 'Linked skills');
      await waitForText(sessionId, 'Local Catalog Skill');
      await clickByText(sessionId, 'button', 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');
      await waitForText(sessionId, 'Scope bindings');

      await clickSelector(sessionId, '[data-role="settings-tab-workflows"]');
      await waitForText(sessionId, 'Workflow library');
      await clickByText(sessionId, '[aria-label="Workflows"] a', 'Development');
      await clickSelector(sessionId, '[data-role="workflow-detail-tab-skills"]');
      await waitForText(sessionId, 'Workflow-linked skills');
      await waitForText(sessionId, 'Local Catalog Skill');
      await clickByText(sessionId, 'button', 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="skill-detail-tab-assignments"]');
      await waitForText(sessionId, 'Workflow lane · Development → Implement');

      await clickSelector(sessionId, '[data-role="skill-binding-global-toggle"]');
      await clickSelector(sessionId, '[data-role="save-skill-bindings"]');
      await waitForText(sessionId, '1 binding');
      await waitForText(sessionId, 'Global · Global');
      await waitForText(sessionId, 'Clear all scope bindings before deleting this skill.');
      await expect.poll(async () => executeScript<boolean>(sessionId, `
        const button = document.querySelector('[data-role="delete-skill"]');
        return Boolean(button && button.disabled);
      `)).toBe(true);

      await clickSelector(sessionId, '[data-role="skill-binding-global-toggle"]');
      await clickSelector(sessionId, '[data-role="save-skill-bindings"]');
      await waitForText(sessionId, 'No bindings yet.');
      await expect.poll(async () => executeScript<boolean>(sessionId, `
        const button = document.querySelector('[data-role="delete-skill"]');
        return Boolean(button && !button.disabled);
      `)).toBe(true);

      await clickSelector(sessionId, '[data-role="skill-detail-tab-editor"]');
      await setInputValue(sessionId, '[data-role="skill-slug"]', 'local-catalog-skill-renamed');
      await setInputValue(sessionId, '[data-role="skill-markdown-body"]', '# Title\n\nUpdated local catalog skill summary.\n');
      await clickSelector(sessionId, '[data-role="save-skill"]');

      await expect.poll(() => existsSync(renamedLocalSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(true);
      await expect.poll(() => existsSync(localSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(false);
      await waitForText(sessionId, 'Updated local catalog skill summary.');

      await clickSelector(sessionId, '[data-role="archive-skill"]');
      await waitForText(sessionId, 'Archived');
      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'archived');
      await waitForText(sessionId, 'Local Catalog Skill');
      await clickSelector(sessionId, '[data-role="unarchive-skill"]');
      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'all');
      await waitForText(sessionId, 'Local Catalog Skill');

      await clickSelector(sessionId, '[data-role="delete-skill"]');
      await waitForText(sessionId, 'Confirm delete');
      await clickSelector(sessionId, '[data-role="delete-skill"]');
      await expect.poll(() => existsSync(renamedLocalSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(false);
      await expect.poll(async () => (await bodyText(sessionId)).includes('Local Catalog Skill')).toBe(false);

      await clickSelector(sessionId, '[data-role="new-skill"]');
      await setInputValue(sessionId, '[data-role="skill-name"]', 'Shadow Winner');
      await setInputValue(sessionId, '[data-role="skill-slug"]', 'external-readonly');
      await setInputValue(sessionId, '[data-role="skill-markdown-body"]', '# Title\n\nLocal shadow copy.\n');
      await clickSelector(sessionId, '[data-role="save-skill"]');
      await expect.poll(() => existsSync(shadowLocalSkillPath), { timeout: FILE_WRITE_TIMEOUT_MS }).toBe(true);
      await clickByText(sessionId, '[role="tab"]', 'Assignments');
      await setInputValue(sessionId, '[data-role="skill-project-search"]', 'orchestra');
      await clickByText(sessionId, 'button', 'Add Orchestra');
      await clickSelector(sessionId, '[data-role="save-skill-bindings"]');
      await waitForText(sessionId, 'Scoped/ambient conflicts need operator review');
      await waitForText(sessionId, 'Ambient conflicts · 1');
      await waitForText(sessionId, 'external-readonly · ambient via default ~/.agents/skills ambient discovery · scoped via project');

      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'shadowed');
      await clickByText(sessionId, '[data-role="skills-list"] button', 'external-readonly');
      await waitForText(sessionId, 'Shadowed by another skill');
      await waitForText(sessionId, 'Shadow Winner currently takes precedence for this slug.');
      await waitForText(sessionId, 'Scoped/ambient conflicts need operator review');

      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'invalid');
      await clickByText(sessionId, '[data-role="skills-list"] button', 'bad_slug');
      await waitForText(sessionId, 'Invalid external skill');
      await waitForText(sessionId, 'Directory name must use lowercase letters, numbers, and single dashes only.');

      rmSync(join(testHome!, '.agents', 'skills', 'missing-skill'), { force: true, recursive: true });
      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'all');
      await clickSelector(sessionId, '[data-role="refresh-external-skills"]');
      await setInputValue(sessionId, '[data-role="skills-status-filter"]', 'missing');
      await clickByText(sessionId, '[data-role="skills-list"] button', 'missing-skill');
      await waitForText(sessionId, 'Missing on disk');
      await waitForText(sessionId, 'This external skill directory was indexed previously but is no longer present on disk.');
    } finally {
      await deleteWebdriverSession(sessionId);
      await sleep(250);
    }
  }, 240_000);
});
