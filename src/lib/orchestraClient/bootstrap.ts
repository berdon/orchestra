import type { AppInfo } from "../../types";

export const ORCHESTRA_CLIENT_CONTRACT_VERSION = "2026-05-10" as const;

export type OrchestraClientContractVersion = typeof ORCHESTRA_CLIENT_CONTRACT_VERSION;
export type OrchestraClientHostKind = "tauri" | "remote_api" | "mock";
export type OrchestraClientAuthMode = "desktop_session" | "same_origin_cookie" | "bearer_token" | "none";
export type OrchestraCapabilityAvailability = "available" | "unavailable" | "unknown";

export interface OrchestraCapabilityDescriptor {
  availability: OrchestraCapabilityAvailability;
  reason?: string | null;
}

export interface OrchestraClientFeatureFlags {
  sharedCatalog: boolean;
  sharedTasks: boolean;
  sharedInbox: boolean;
  sharedSessions: boolean;
  sharedSkills: boolean;
  sharedNotes: boolean;
  taskSchedules: boolean;
  sessionStreaming: boolean;
  sessionControls: boolean;
  taskComments: boolean;
  taskFiles: boolean;
  taskBrowser?: boolean;
  taskPullRequests?: boolean;
  desktopWindows: boolean;
  agentTerminal: boolean;
}

export interface OrchestraClientCapabilities {
  app: {
    bootstrap: OrchestraCapabilityDescriptor;
    errorReporting: OrchestraCapabilityDescriptor;
  };
  catalog: {
    projects: OrchestraCapabilityDescriptor;
    agents: OrchestraCapabilityDescriptor;
    roles: OrchestraCapabilityDescriptor;
    workflows: OrchestraCapabilityDescriptor;
  };
  admin: {
    projects: OrchestraCapabilityDescriptor;
    settings: OrchestraCapabilityDescriptor;
    workers: OrchestraCapabilityDescriptor;
    workflows: OrchestraCapabilityDescriptor;
    policies: OrchestraCapabilityDescriptor;
    channels: OrchestraCapabilityDescriptor;
    modelCatalog: OrchestraCapabilityDescriptor;
    piExecutableDiagnostic: OrchestraCapabilityDescriptor;
  };
  skills: {
    read: OrchestraCapabilityDescriptor;
    create: OrchestraCapabilityDescriptor;
    update: OrchestraCapabilityDescriptor;
    archive: OrchestraCapabilityDescriptor;
    delete: OrchestraCapabilityDescriptor;
    assign: OrchestraCapabilityDescriptor;
  };
  notes: {
    read: OrchestraCapabilityDescriptor;
    write: OrchestraCapabilityDescriptor;
  };
  tasks: {
    read: OrchestraCapabilityDescriptor;
    write: OrchestraCapabilityDescriptor;
    review: OrchestraCapabilityDescriptor;
    comments: OrchestraCapabilityDescriptor;
    commentDelete: OrchestraCapabilityDescriptor;
    commentDeleteImpact: OrchestraCapabilityDescriptor;
    todos: OrchestraCapabilityDescriptor;
    dependencies: OrchestraCapabilityDescriptor;
    attachments: OrchestraCapabilityDescriptor;
    fileReferences: OrchestraCapabilityDescriptor;
    fileContents: OrchestraCapabilityDescriptor;
    pullRequests?: OrchestraCapabilityDescriptor;
    schedules: OrchestraCapabilityDescriptor;
    browser?: OrchestraCapabilityDescriptor;
  };
  inbox: {
    read: OrchestraCapabilityDescriptor;
    write: OrchestraCapabilityDescriptor;
    archive: OrchestraCapabilityDescriptor;
  };
  sessions: {
    read: OrchestraCapabilityDescriptor;
    write: OrchestraCapabilityDescriptor;
    stream: OrchestraCapabilityDescriptor;
    runtimeControls: OrchestraCapabilityDescriptor;
    modelSelection: OrchestraCapabilityDescriptor;
  };
  host: {
    logsWindow: OrchestraCapabilityDescriptor;
    agentTerminal: OrchestraCapabilityDescriptor;
    systemNotifications: OrchestraCapabilityDescriptor;
    bridgeDiagnostics: OrchestraCapabilityDescriptor;
    runtimeLogs: OrchestraCapabilityDescriptor;
    harnessSettings: OrchestraCapabilityDescriptor;
    remoteAccess: OrchestraCapabilityDescriptor;
  };
}

export interface OrchestraClientTransportUrls {
  apiBaseUrl: string | null;
  websocketUrl: string | null;
}

export interface OrchestraClientBootstrap {
  contractVersion: OrchestraClientContractVersion;
  bootstrappedAt: string;
  hostKind: OrchestraClientHostKind;
  authMode: OrchestraClientAuthMode;
  urls: OrchestraClientTransportUrls;
  featureFlags: OrchestraClientFeatureFlags;
  capabilities: OrchestraClientCapabilities;
  appInfo: AppInfo | null;
}
