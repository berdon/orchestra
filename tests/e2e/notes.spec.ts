import { expect, test } from "@playwright/test";

test("notes page uses the shared mobile sub-navigation header and action menu on mobile", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.confirm = () => true;

    const timestamp = new Date().toISOString();
    const projectId = "project-notes-1";
    const projectSlug = "notes-fixture";
    const repositoryId = "repo-docs";

    window.localStorage.setItem("orchestra.mock.active-project-id", projectId);
    window.localStorage.setItem("orchestra.preferences.active-project-id", projectId);
    window.localStorage.setItem("orchestra.preferences.active-project-slug", projectSlug);

    window.localStorage.setItem(
      "orchestra.mock.projects",
      JSON.stringify([
        {
          id: projectId,
          slug: projectSlug,
          name: "Notes Fixture",
          description: "Project fixture for Notes mobile navigation coverage.",
          taskPrefix: "NOT",
          defaultRepositoryId: repositoryId,
          createdAt: timestamp,
          updatedAt: timestamp,
          repositories: [
            {
              id: repositoryId,
              projectId,
              slug: "docs-repository",
              name: "Docs Repository",
              repositoryPath: "/tmp/docs-repository",
              sourcePath: null,
              sourceKind: "local",
              mode: "existing",
              defaultBranch: "main",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      ]),
    );

    window.localStorage.setItem(
      "orchestra.mock.notes",
      JSON.stringify({
        [`${projectId}::project`]: {
          directories: ["planning", "planning/mobile"],
          notes: {
            "planning/roadmap.md": "# Roadmap\n\nProject roadmap note body.\n",
            "planning/mobile/ux.md": "# Mobile UX\n\nShared floating sub-navigation notes.\n",
          },
        },
        [`${projectId}::repository:${repositoryId}`]: {
          directories: ["guides"],
          notes: {
            "guides/setup.md": "# Setup\n\nRepository note body.\n",
          },
        },
      }),
    );
  });

  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto("/?page=notes&projectId=project-notes-1");

  const mobileSubnav = page.locator('[data-role="notes-mobile-subnav-shell"]');
  const mobileSelect = page.locator('[data-role="notes-mobile-subnav-select-control"]');

  await expect(mobileSubnav).toBeVisible();
  await expect(mobileSelect).toBeVisible();
  await expect(mobileSubnav.locator('.settings-mobile-subnav__label')).toHaveCount(0);
  await expect(page.locator('[data-role="notes-mobile-subnav-menu-trigger"]')).toBeVisible();
  await expect(page.locator('.notes-page__navigation.settings-mobile-subnav-panel')).toBeHidden();
  await expect(page.locator('.notes-page__nav-tree.settings-mobile-subnav-list')).toBeHidden();

  await mobileSelect.selectOption({ label: "Project · Note · planning/roadmap.md" });
  await expect(page.locator('[data-role="notes-markdown-editor"]')).toHaveValue(/Project roadmap note body\./);

  const detailMetrics = await page.evaluate(() => {
    const detail = document.querySelector('.notes-page__detail')?.getBoundingClientRect();
    const editor = document.querySelector('.notes-markdown-editor')?.getBoundingClientRect();
    return detail && editor
      ? {
          detailLeft: detail.left,
          detailWidth: detail.width,
          editorWidth: editor.width,
          viewportWidth: window.innerWidth,
        }
      : null;
  });
  expect(detailMetrics).not.toBeNull();
  expect(detailMetrics?.detailLeft ?? 0).toBeLessThanOrEqual(16);
  expect(detailMetrics?.detailWidth ?? 0).toBeGreaterThanOrEqual((detailMetrics?.viewportWidth ?? 0) - 32);
  expect(detailMetrics?.editorWidth ?? 0).toBeGreaterThanOrEqual((detailMetrics?.viewportWidth ?? 0) - 64);

  await page.locator('[data-role="notes-mobile-subnav-menu-trigger"]').click();
  const actionMenu = page.locator('.task-action-menu__dropdown');
  await expect(actionMenu.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(actionMenu.getByRole('button', { name: 'New note' })).toBeVisible();
  await expect(actionMenu.getByRole('button', { name: 'New folder' })).toBeVisible();
  await expect(actionMenu.getByRole('button', { name: 'Move / rename' })).toBeVisible();
  await expect(actionMenu.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(actionMenu.getByRole('button', { name: 'Delete' })).toBeVisible();

  await page.evaluate(() => {
    const detail = document.querySelector('.notes-page__detail') as HTMLElement | null;
    if (detail) {
      detail.style.minHeight = '1600px';
    }
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => Boolean(document.querySelector('[data-role="notes-mobile-subnav-floating-shell"]')));
  await page.waitForFunction(() => document.querySelector('[data-role="notes-mobile-subnav-floating-shell"]')?.getAttribute('data-scroll-state') === 'hidden');

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 520;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForFunction(() => document.querySelector('[data-role="notes-mobile-subnav-floating-shell"]')?.getAttribute('data-scroll-state') === 'hidden');

  await page.evaluate(() => {
    const content = document.querySelector('.content') as HTMLElement | null;
    if (content) {
      content.scrollTop = 420;
      content.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForFunction(() => document.querySelector('[data-role="notes-mobile-subnav-floating-shell"]')?.getAttribute('data-scroll-state') === 'visible');
});
