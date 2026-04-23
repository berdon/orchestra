import type { OrchestraClient } from "./client";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION, type OrchestraClientBootstrap } from "./bootstrap";
import { subscribeToOrchestraBrowserEvents } from "./browserEvents";
import type { OrchestraHostAdminExtension, OrchestraShellExtension } from "./extensions";
import type { OrchestraClientServiceBindings } from "./serviceBindings";

interface OrchestraClientExtensions {
  shell?: OrchestraShellExtension;
  hostAdmin?: OrchestraHostAdminExtension;
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
    tasks: services.tasks,
    inbox: services.inbox,
    sessions: services.sessions,
    events: {
      subscribe: subscribeToOrchestraBrowserEvents,
    },
    shell: extensions?.shell,
    hostAdmin: extensions?.hostAdmin,
  };
}
