import type { TaskListOptions, TaskSummary } from "../../types";
import type { OrchestraClient, OrchestraTaskService } from "./client";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION, type OrchestraClientBootstrap } from "./bootstrap";
import { subscribeToOrchestraBrowserEvents } from "./browserEvents";
import {
  createStaticConnectionService,
  type OrchestraConnectionService,
} from "./connection";
import type { OrchestraHostAdminExtension, OrchestraLocalNotificationsExtension, OrchestraShellExtension } from "./extensions";
import type { OrchestraClientServiceBindings } from "./serviceBindings";

interface OrchestraClientExtensions {
  shell?: OrchestraShellExtension;
  notifications?: OrchestraLocalNotificationsExtension;
  hostAdmin?: OrchestraHostAdminExtension;
  connection?: OrchestraConnectionService;
}

const TASK_LIST_REUSE_WINDOW_MS = 250;

function createTaskListRequestKey(options?: TaskListOptions) {
  return JSON.stringify({
    includeArchived: options?.includeArchived ?? false,
    projectId: options?.projectId ?? null,
    tags: options?.tags ?? null,
    tagMatch: options?.tagMatch ?? null,
    sortBy: options?.sortBy ?? null,
    sortDirection: options?.sortDirection ?? null,
  });
}

function createCoalescedTaskService(tasks: OrchestraTaskService): OrchestraTaskService {
  const listRequests = new Map<
    string,
    { expiresAt: number; promise: Promise<TaskSummary[]> }
  >();
  const invalidatingMethods = new Set<keyof OrchestraTaskService>([
    "create",
    "update",
    "remove",
    "addTodo",
    "markTodoFinished",
    "markTodoUnfinished",
    "deleteTodo",
    "comment",
    "updateComment",
    "deleteComment",
    "markCommentsRead",
    "addDependency",
    "removeDependency",
    "addFileReference",
    "setDefaultFileReference",
    "removeFileReference",
    "addAttachment",
    "removeAttachment",
    "createSchedule",
    "updateSchedule",
    "deleteSchedule",
    "dispatch",
    "complete",
    "approveReview",
    "approveCompletion",
    "markNeedsWork",
    "resume",
    "pause",
    "stopActivity",
    "reassign",
    "manualWhip",
    "resetRuntime",
  ]);

  const clearListRequests = () => {
    listRequests.clear();
  };

  const pruneExpiredRequests = (now: number) => {
    for (const [key, entry] of listRequests.entries()) {
      if (entry.expiresAt <= now) {
        listRequests.delete(key);
      }
    }
  };

  const list: OrchestraTaskService["list"] = (options) => {
    const now = Date.now();
    pruneExpiredRequests(now);
    const key = createTaskListRequestKey(options);
    const cached = listRequests.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const promise = tasks.list(options);
    listRequests.set(key, {
      expiresAt: now + TASK_LIST_REUSE_WINDOW_MS,
      promise,
    });

    void promise
      .then(() => {
        const current = listRequests.get(key);
        if (current?.promise === promise) {
          current.expiresAt = Date.now() + TASK_LIST_REUSE_WINDOW_MS;
        }
      })
      .catch(() => {
        const current = listRequests.get(key);
        if (current?.promise === promise) {
          listRequests.delete(key);
        }
      });

    return promise;
  };

  return new Proxy(tasks, {
    get(target, property, receiver) {
      if (property === "list") {
        return list;
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (!invalidatingMethods.has(property as keyof OrchestraTaskService)) {
        return value.bind(target);
      }

      return (...args: unknown[]) => {
        clearListRequests();
        return Promise.resolve(value.apply(target, args)).finally(() => {
          clearListRequests();
        });
      };
    },
  }) as OrchestraTaskService;
}

export function createOrchestraClient(
  getBootstrap: () => Promise<OrchestraClientBootstrap>,
  services: OrchestraClientServiceBindings,
  extensions?: OrchestraClientExtensions,
): OrchestraClient {
  return {
    contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
    getBootstrap,
    app: services.app,
    catalog: services.catalog,
    projects: services.projects,
    settings: services.settings,
    workers: services.workers,
    workflows: services.workflows,
    policies: services.policies,
    channels: services.channels,
    skills: services.skills,
    notes: services.notes,
    tasks: createCoalescedTaskService(services.tasks),
    inbox: services.inbox,
    sessions: services.sessions,
    events: {
      subscribe: subscribeToOrchestraBrowserEvents,
    },
    connection: extensions?.connection ?? createStaticConnectionService({
      hostState: "online",
      liveState: "connected",
      degraded: false,
      retrying: false,
      retryAttempt: 0,
      lastTransitionAt: new Date().toISOString(),
      lastError: null,
    }),
    shell: extensions?.shell,
    notifications: extensions?.notifications,
    hostAdmin: extensions?.hostAdmin,
  };
}
