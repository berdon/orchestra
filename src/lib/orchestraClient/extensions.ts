import type {
  BridgeCleanupEvent,
  BridgeDiagnostics,
  LogEntry,
  PiImportLegacyResult,
  PiOAuthFlowState,
  PiRuntimeSettings,
  PiSetupState,
  RemoteAccessSettingsInput,
  RemoteAccessStatus,
  RemoteDeviceRecord,
  RemotePairingCode,
  RemotePairingCodeInput,
  SessionRecord,
  SystemNotificationEnvironmentStatus,
  SystemNotificationPermissionState,
} from "../../types";
import type { OrchestraCapabilityDescriptor, OrchestraClientBootstrap } from "./bootstrap";

export interface OrchestraShellWindowState {
  isLogsWindow: boolean;
  isAgentTerminalWindow: boolean;
  agentTerminalSessionId: string | null;
}

export interface OrchestraShellAgentTerminalExtension {
  openSession(agentId: string, projectId?: string | null): Promise<SessionRecord>;
  writeInput(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  getBuffer(sessionId: string): Promise<string>;
  shutdown(sessionId: string): Promise<void>;
}

export interface OrchestraShellExtension {
  getInitialWindowState(): OrchestraShellWindowState;
  getWindowState(): Promise<OrchestraShellWindowState>;
  openLogsWindow(): Promise<void>;
  readonly agentTerminal: OrchestraShellAgentTerminalExtension;
}

export interface OrchestraHostAdminNotificationsExtension {
  getEnvironmentStatus(): Promise<SystemNotificationEnvironmentStatus>;
  getPermissionState(): Promise<SystemNotificationPermissionState>;
  requestPermission(): Promise<SystemNotificationPermissionState>;
  send(input: { title: string; body: string; tag?: string; iconPath?: string }): Promise<boolean>;
  sendTest(): Promise<boolean>;
}

export interface OrchestraHostAdminHarnessExtension {
  getSetupState(): Promise<PiSetupState>;
  getRuntimeSettings(): Promise<PiRuntimeSettings>;
  updateRuntimeSettings(input: { extraExtensions: string[]; defaultCompactionWindow: string }): Promise<PiRuntimeSettings>;
  getOAuthFlowState(): Promise<PiOAuthFlowState | null>;
  getModelsJson(): Promise<string>;
  saveModelsJson(content: string): Promise<PiSetupState>;
  setProviderApiKey(providerId: string, apiKey: string): Promise<PiSetupState>;
  removeProviderCredential(providerId: string): Promise<PiSetupState>;
  importLegacyConfig(replaceExisting?: boolean): Promise<PiSetupState>;
  dismissLegacyImport(): Promise<PiSetupState>;
  importLegacyConfiguration(input: { importAuth: boolean; importModels: boolean }): Promise<PiImportLegacyResult>;
  startOAuthFlow(providerId: string, methodId?: string | null): Promise<PiOAuthFlowState>;
  submitOAuthFlowInput(value: string): Promise<PiOAuthFlowState>;
  cancelOAuthFlow(): Promise<PiOAuthFlowState | null>;
  dismissOAuthFlow(): Promise<PiOAuthFlowState | null>;
}

export interface OrchestraHostAdminRemoteAccessExtension {
  getStatus(): Promise<RemoteAccessStatus>;
  updateSettings(input: RemoteAccessSettingsInput): Promise<RemoteAccessStatus>;
  createPairingCode(input?: RemotePairingCodeInput | null): Promise<RemotePairingCode>;
  revokeDevice(deviceId: string): Promise<RemoteDeviceRecord>;
}

export interface OrchestraHostAdminExtension {
  readonly bridge: {
    getDiagnostics(): Promise<BridgeDiagnostics>;
    cleanupStaleInstances(): Promise<BridgeCleanupEvent[]>;
  };
  readonly logs: {
    list(): Promise<LogEntry[]>;
    clear(): Promise<void>;
    exportBundle(includeRelatedSessionSnapshot?: boolean): Promise<string>;
  };
  readonly notifications: OrchestraHostAdminNotificationsExtension;
  readonly harness: OrchestraHostAdminHarnessExtension;
  readonly remoteAccess: OrchestraHostAdminRemoteAccessExtension;
}

export function defaultOrchestraShellWindowState(): OrchestraShellWindowState {
  return {
    isLogsWindow: false,
    isAgentTerminalWindow: false,
    agentTerminalSessionId: null,
  };
}

export function isCapabilityAvailable(descriptor?: OrchestraCapabilityDescriptor | null) {
  return descriptor?.availability === "available";
}

export function supportsLogsWindow(
  client: { shell?: OrchestraShellExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.shell) && isCapabilityAvailable(bootstrap.capabilities.host.logsWindow);
}

export function supportsAgentTerminal(
  client: { shell?: OrchestraShellExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.shell?.agentTerminal) && isCapabilityAvailable(bootstrap.capabilities.host.agentTerminal);
}

export function supportsRuntimeLogs(
  client: { hostAdmin?: OrchestraHostAdminExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.hostAdmin) && isCapabilityAvailable(bootstrap.capabilities.host.runtimeLogs);
}

export function supportsBridgeDiagnostics(
  client: { hostAdmin?: OrchestraHostAdminExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.hostAdmin) && isCapabilityAvailable(bootstrap.capabilities.host.bridgeDiagnostics);
}

export function supportsSystemNotifications(
  client: { hostAdmin?: OrchestraHostAdminExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.hostAdmin) && isCapabilityAvailable(bootstrap.capabilities.host.systemNotifications);
}

export function supportsHarnessSettings(
  client: { hostAdmin?: OrchestraHostAdminExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.hostAdmin) && isCapabilityAvailable(bootstrap.capabilities.host.harnessSettings);
}

export function supportsRemoteAccess(
  client: { hostAdmin?: OrchestraHostAdminExtension },
  bootstrap: OrchestraClientBootstrap,
) {
  return Boolean(client.hostAdmin) && isCapabilityAvailable(bootstrap.capabilities.host.remoteAccess);
}
