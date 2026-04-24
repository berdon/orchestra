import type {
  OrchestraCatalogService,
  OrchestraInboxService,
  OrchestraSessionService,
  OrchestraTaskService,
  OrchestraAppService,
} from "./client";
import {
  type OrchestraClientErrorSource,
  toOrchestraClientError,
} from "./errors";

export interface OrchestraClientServiceBindings {
  app: OrchestraAppService;
  catalog: OrchestraCatalogService;
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
    tasks: wrapServiceMethods("tasks", source, bindings.tasks),
    inbox: wrapServiceMethods("inbox", source, bindings.inbox),
    sessions: wrapServiceMethods("sessions", source, bindings.sessions),
  };
}
