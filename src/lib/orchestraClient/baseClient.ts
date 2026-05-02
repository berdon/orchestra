import type { OrchestraClient } from "./client";
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
    tasks: services.tasks,
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
