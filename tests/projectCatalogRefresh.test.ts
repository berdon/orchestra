import { describe, expect, it, vi } from "vitest";

import {
  createProjectCatalogRefresher,
  resolveActiveProjectIdAfterProjectCatalogRefresh,
} from "../src/lib/projectCatalogRefresh";
import type { ProjectSummary } from "../src/types";

function createDeferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function makeProject(
  overrides: Partial<ProjectSummary> &
    Pick<ProjectSummary, "id" | "slug" | "name">,
): ProjectSummary {
  return {
    id: overrides.id,
    slug: overrides.slug,
    name: overrides.name,
    description: overrides.description ?? null,
    taskPrefix: overrides.taskPrefix ?? "PRJ",
    defaultRepositoryId: overrides.defaultRepositoryId ?? null,
    createdAt: overrides.createdAt ?? "2026-05-03T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-03T00:00:00.000Z",
  };
}

describe("projectCatalogRefresh", () => {
  it("ignores an older refresh response that arrives after a newer project-create refresh", async () => {
    const firstLoad = createDeferred<ProjectSummary[]>();
    const secondLoad = createDeferred<ProjectSummary[]>();
    const applyProjects = vi.fn();
    const listProjects = vi
      .fn<() => Promise<ProjectSummary[]>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    const refreshProjectCatalog = createProjectCatalogRefresher(
      listProjects,
      applyProjects,
    );

    const firstRefresh = refreshProjectCatalog();
    const secondRefresh = refreshProjectCatalog();

    secondLoad.resolve([
      makeProject({
        id: "project-existing",
        slug: "existing",
        name: "Existing Project",
      }),
      makeProject({
        id: "project-new",
        slug: "new-project",
        name: "New Project",
      }),
    ]);
    await expect(secondRefresh).resolves.toBe(true);

    firstLoad.resolve([
      makeProject({
        id: "project-existing",
        slug: "existing",
        name: "Existing Project",
      }),
    ]);
    await expect(firstRefresh).resolves.toBe(false);

    expect(applyProjects).toHaveBeenCalledTimes(1);
    expect(applyProjects).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "project-existing",
        name: "Existing Project",
      }),
      expect.objectContaining({ id: "project-new", name: "New Project" }),
    ]);
  });

  it("ignores an older refresh response that arrives after a newer project-rename refresh", async () => {
    const firstLoad = createDeferred<ProjectSummary[]>();
    const secondLoad = createDeferred<ProjectSummary[]>();
    const applyProjects = vi.fn();
    const listProjects = vi
      .fn<() => Promise<ProjectSummary[]>>()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    const refreshProjectCatalog = createProjectCatalogRefresher(
      listProjects,
      applyProjects,
    );

    const firstRefresh = refreshProjectCatalog();
    const secondRefresh = refreshProjectCatalog();

    secondLoad.resolve([
      makeProject({
        id: "project-1",
        slug: "renamed-project",
        name: "Renamed Project",
      }),
    ]);
    await expect(secondRefresh).resolves.toBe(true);

    firstLoad.resolve([
      makeProject({
        id: "project-1",
        slug: "original-project",
        name: "Original Project",
      }),
    ]);
    await expect(firstRefresh).resolves.toBe(false);

    expect(applyProjects).toHaveBeenCalledTimes(1);
    expect(applyProjects).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "project-1",
        slug: "renamed-project",
        name: "Renamed Project",
      }),
    ]);
  });

  it("keeps the stored active project when it is still present after refresh", () => {
    const projects = [
      makeProject({ id: "project-a", slug: "alpha", name: "Alpha" }),
      makeProject({ id: "project-b", slug: "beta", name: "Beta" }),
    ];

    expect(
      resolveActiveProjectIdAfterProjectCatalogRefresh(
        projects,
        "project-b",
        "project-a",
      ),
    ).toBe("project-b");
  });

  it("falls back to the current active project before using the first listed project", () => {
    const projects = [
      makeProject({ id: "project-a", slug: "alpha", name: "Alpha" }),
      makeProject({ id: "project-b", slug: "beta", name: "Beta" }),
    ];

    expect(
      resolveActiveProjectIdAfterProjectCatalogRefresh(
        projects,
        "project-missing",
        "project-b",
      ),
    ).toBe("project-b");
    expect(
      resolveActiveProjectIdAfterProjectCatalogRefresh(
        projects,
        "project-missing",
        "project-missing-too",
      ),
    ).toBe("project-a");
    expect(
      resolveActiveProjectIdAfterProjectCatalogRefresh([], null, null),
    ).toBeNull();
  });
});
