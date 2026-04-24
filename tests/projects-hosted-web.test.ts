import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createOptimisticOrchestraClientBootstrap } from "../src/lib/orchestraClient/bootstrapFactory";
import { registerActiveOrchestraClientBinding } from "../src/lib/orchestraClient/runtime";
import {
  createProject,
  createRepository,
  setProjectDefaultRepository,
} from "../src/lib/projects";

function registerHostedWebClient(overrides?: {
  createProject?: (input: { name: string; description?: string | null; taskPrefix: string }) => Promise<unknown>;
  createRepository?: (projectId: string, input: { name: string; repositoryPath?: string | null; defaultBranch?: string | null }) => Promise<unknown>;
  setProjectDefaultRepository?: (projectId: string, repositoryId: string | null) => Promise<unknown>;
}) {
  registerActiveOrchestraClientBinding({
    bootstrap: createOptimisticOrchestraClientBootstrap("remote_api"),
    client: {
      projects: {
        createProject: overrides?.createProject ?? vi.fn(async () => ({ id: "project-1" })),
        createRepository: overrides?.createRepository ?? vi.fn(async () => ({ id: "repo-1" })),
        setProjectDefaultRepository: overrides?.setProjectDefaultRepository ?? vi.fn(async () => ({ id: "project-1" })),
      },
    },
  } as any);
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  registerActiveOrchestraClientBinding(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hosted-web project invalidation", () => {
  test("emits orchestra:projects-changed after a successful hosted-web createProject mutation", async () => {
    const remoteCreateProject = vi.fn(async () => ({
      id: "project-hosted-web",
      slug: "hosted-web-project",
      name: "Hosted Web Project",
      description: "Created through the remote API",
      taskPrefix: "HWP",
      defaultRepositoryId: null,
      repositories: [],
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:00:00.000Z",
    }));
    const projectsChanged = vi.fn();
    window.addEventListener("orchestra:projects-changed", projectsChanged);
    registerHostedWebClient({ createProject: remoteCreateProject });

    const created = await createProject({
      name: "Hosted Web Project",
      description: "Created through the remote API",
      taskPrefix: "HWP",
    });

    expect(remoteCreateProject).toHaveBeenCalledWith({
      name: "Hosted Web Project",
      description: "Created through the remote API",
      taskPrefix: "HWP",
    });
    expect(created).toMatchObject({
      id: "project-hosted-web",
      slug: "hosted-web-project",
      name: "Hosted Web Project",
    });
    expect(projectsChanged).toHaveBeenCalledTimes(1);

    window.removeEventListener("orchestra:projects-changed", projectsChanged);
  });

  test("emits orchestra:projects-changed for hosted-web repository mutations that affect app-level project lists", async () => {
    const remoteCreateRepository = vi.fn(async () => ({
      id: "repo-hosted-web",
      projectId: "project-hosted-web",
      name: "Hosted Web Repo",
    }));
    const remoteSetDefaultRepository = vi.fn(async () => ({
      id: "project-hosted-web",
      defaultRepositoryId: "repo-hosted-web",
    }));
    const projectsChanged = vi.fn();
    window.addEventListener("orchestra:projects-changed", projectsChanged);
    registerHostedWebClient({
      createRepository: remoteCreateRepository,
      setProjectDefaultRepository: remoteSetDefaultRepository,
    });

    await createRepository("project-hosted-web", {
      name: "Hosted Web Repo",
      repositoryPath: "/tmp/hosted-web-repo",
      defaultBranch: "main",
    });
    await setProjectDefaultRepository("project-hosted-web", "repo-hosted-web");

    expect(remoteCreateRepository).toHaveBeenCalledWith("project-hosted-web", {
      name: "Hosted Web Repo",
      repositoryPath: "/tmp/hosted-web-repo",
      defaultBranch: "main",
    });
    expect(remoteSetDefaultRepository).toHaveBeenCalledWith("project-hosted-web", "repo-hosted-web");
    expect(projectsChanged).toHaveBeenCalledTimes(2);

    window.removeEventListener("orchestra:projects-changed", projectsChanged);
  });

  test("does not emit orchestra:projects-changed when a hosted-web createProject mutation fails", async () => {
    const remoteCreateProject = vi.fn(async () => {
      throw new Error("Remote create failed");
    });
    const projectsChanged = vi.fn();
    window.addEventListener("orchestra:projects-changed", projectsChanged);
    registerHostedWebClient({ createProject: remoteCreateProject });

    await expect(createProject({
      name: "Broken Hosted Web Project",
      description: "",
      taskPrefix: "BHP",
    })).rejects.toThrow("Remote create failed");
    expect(projectsChanged).not.toHaveBeenCalled();

    window.removeEventListener("orchestra:projects-changed", projectsChanged);
  });
});
