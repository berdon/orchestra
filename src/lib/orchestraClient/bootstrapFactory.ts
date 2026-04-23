import type { AppInfo } from "../../types";
import type {
  OrchestraCapabilityDescriptor,
  OrchestraClientAuthMode,
  OrchestraClientBootstrap,
  OrchestraClientCapabilities,
  OrchestraClientFeatureFlags,
  OrchestraClientHostKind,
} from "./bootstrap";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION } from "./bootstrap";

function nowIso() {
  return new Date().toISOString();
}

function availableCapability(): OrchestraCapabilityDescriptor {
  return { availability: "available" };
}

function unavailableCapability(reason: string): OrchestraCapabilityDescriptor {
  return {
    availability: "unavailable",
    reason,
  };
}

function resolveAuthMode(hostKind: OrchestraClientHostKind): OrchestraClientAuthMode {
  switch (hostKind) {
    case "tauri":
      return "desktop_session";
    case "remote_api":
      return "bearer_token";
    default:
      return "none";
  }
}

function resolveFeatureFlags(hostKind: OrchestraClientHostKind): OrchestraClientFeatureFlags {
  const desktopWindows = hostKind === "tauri";
  return {
    sharedCatalog: true,
    sharedTasks: true,
    sharedInbox: true,
    sharedSessions: true,
    taskSchedules: true,
    sessionStreaming: true,
    sessionControls: true,
    taskComments: true,
    taskFiles: true,
    desktopWindows,
    agentTerminal: desktopWindows,
  };
}

function resolveCapabilities(hostKind: OrchestraClientHostKind): OrchestraClientCapabilities {
  const desktopOnlyReason = "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.";
  const available = availableCapability();

  return {
    app: {
      bootstrap: available,
      errorReporting: available,
    },
    catalog: {
      projects: available,
      agents: available,
      roles: available,
      workflows: available,
    },
    tasks: {
      read: available,
      write: available,
      review: available,
      comments: available,
      todos: available,
      dependencies: available,
      attachments: available,
      fileReferences: available,
      fileContents: available,
      schedules: available,
    },
    inbox: {
      read: available,
      write: available,
      archive: available,
    },
    sessions: {
      read: available,
      write: available,
      stream: available,
      runtimeControls: available,
      modelSelection: available,
    },
    host: {
      logsWindow: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
      agentTerminal: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
      systemNotifications: hostKind === "tauri" ? available : unavailableCapability(desktopOnlyReason),
    },
  };
}

export function createOptimisticOrchestraClientBootstrap(hostKind: OrchestraClientHostKind): OrchestraClientBootstrap {
  return {
    contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
    bootstrappedAt: nowIso(),
    hostKind,
    authMode: resolveAuthMode(hostKind),
    urls: {
      apiBaseUrl: null,
      websocketUrl: null,
    },
    featureFlags: resolveFeatureFlags(hostKind),
    capabilities: resolveCapabilities(hostKind),
    appInfo: null,
  };
}

export async function buildOrchestraClientBootstrap(
  hostKind: OrchestraClientHostKind,
  getAppInfo: () => Promise<AppInfo>,
): Promise<OrchestraClientBootstrap> {
  const optimistic = createOptimisticOrchestraClientBootstrap(hostKind);

  try {
    return {
      ...optimistic,
      appInfo: await getAppInfo(),
      bootstrappedAt: nowIso(),
    };
  } catch {
    return optimistic;
  }
}
