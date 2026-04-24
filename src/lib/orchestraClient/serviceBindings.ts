import type {
  OrchestraCatalogService,
  OrchestraChannelService,
  OrchestraInboxService,
  OrchestraPolicyService,
  OrchestraProjectService,
  OrchestraSessionService,
  OrchestraSettingsService,
  OrchestraTaskService,
  OrchestraAppService,
  OrchestraWorkerService,
  OrchestraWorkflowService,
} from "./client";
import {
  type OrchestraClientErrorSource,
  toOrchestraClientError,
} from "./errors";

export interface OrchestraClientServiceBindings {
  app: OrchestraAppService;
  catalog: OrchestraCatalogService;
  projects: OrchestraProjectService;
  settings: OrchestraSettingsService;
  workers: OrchestraWorkerService;
  workflows: OrchestraWorkflowService;
  policies: OrchestraPolicyService;
  channels: OrchestraChannelService;
  tasks: OrchestraTaskService;
  inbox: OrchestraInboxService;
  sessions: OrchestraSessionService;
}

function wrapServiceMethods<T extends object>(
  serviceName: string,
  source: OrchestraClientErrorSource,
  service: T,
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => Promise.resolve()
        .then(() => value.apply(target, args))
        .catch((error) => {
          throw toOrchestraClientError(error, {
            operation: `${serviceName}.${String(property)}`,
            source,
            fallbackMessage: `${serviceName}.${String(property)} failed.`,
          });
        });
    },
  }) as T;
}

export function withNormalizedBindingErrors(
  bindings: OrchestraClientServiceBindings,
  source: OrchestraClientErrorSource,
): OrchestraClientServiceBindings {
  return {
    app: wrapServiceMethods("app", source, bindings.app),
    catalog: wrapServiceMethods("catalog", source, bindings.catalog),
    projects: wrapServiceMethods("projects", source, bindings.projects),
    settings: wrapServiceMethods("settings", source, bindings.settings),
    workers: wrapServiceMethods("workers", source, bindings.workers),
    workflows: wrapServiceMethods("workflows", source, bindings.workflows),
    policies: wrapServiceMethods("policies", source, bindings.policies),
    channels: wrapServiceMethods("channels", source, bindings.channels),
    tasks: wrapServiceMethods("tasks", source, bindings.tasks),
    inbox: wrapServiceMethods("inbox", source, bindings.inbox),
    sessions: wrapServiceMethods("sessions", source, bindings.sessions),
  };
}
