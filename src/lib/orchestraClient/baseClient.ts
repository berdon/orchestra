import type { OrchestraClient } from "./client";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION, type OrchestraClientBootstrap } from "./bootstrap";
import { subscribeToOrchestraBrowserEvents } from "./browserEvents";
import type { OrchestraClientServiceBindings } from "./serviceBindings";

export function createOrchestraClient(
  getBootstrap: () => Promise<OrchestraClientBootstrap>,
  services: OrchestraClientServiceBindings,
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
  };
}
