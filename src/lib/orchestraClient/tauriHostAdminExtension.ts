import {
  cleanupStaleBridgeInstances,
  clearLogs,
  dismissPiLegacyImport,
  getBridgeDiagnostics,
  getPiModelsJson,
  getPiOAuthFlowState,
  getPiSetupState,
  importLegacyPiConfiguration,
  importPiLegacyConfig,
  cancelPiOAuthFlow,
  dismissPiOAuthFlow,
  exportLogsBundle,
  getLogs,
  removePiProviderCredential,
  savePiModelsJson,
  setPiProviderApiKey,
  startPiOAuthFlow,
  submitPiOAuthFlowInput,
} from "../tauri";
import { getPiRuntimeSettings, updatePiRuntimeSettings } from "../harnessSettings";
import {
  getSystemNotificationEnvironmentStatus,
  getSystemNotificationPermissionState,
  requestSystemNotificationPermission,
  sendSystemNotification,
  sendTestSystemNotification,
} from "../systemNotifications";
import {
  createRemotePairingCode,
  getRemoteAccessStatus,
  revokeRemoteDevice,
  updateRemoteAccessSettings,
} from "../remote";
import type { OrchestraHostAdminExtension } from "./extensions";

export function createTauriHostAdminExtension(): OrchestraHostAdminExtension {
  return {
    bridge: {
      getDiagnostics: getBridgeDiagnostics,
      cleanupStaleInstances: cleanupStaleBridgeInstances,
    },
    logs: {
      list: getLogs,
      clear: clearLogs,
      exportBundle: exportLogsBundle,
    },
    notifications: {
      getEnvironmentStatus: getSystemNotificationEnvironmentStatus,
      getPermissionState: getSystemNotificationPermissionState,
      requestPermission: requestSystemNotificationPermission,
      send: sendSystemNotification,
      sendTest: sendTestSystemNotification,
    },
    harness: {
      getSetupState: getPiSetupState,
      getRuntimeSettings: getPiRuntimeSettings,
      updateRuntimeSettings: updatePiRuntimeSettings,
      getOAuthFlowState: getPiOAuthFlowState,
      getModelsJson: getPiModelsJson,
      saveModelsJson: savePiModelsJson,
      setProviderApiKey: setPiProviderApiKey,
      removeProviderCredential: removePiProviderCredential,
      importLegacyConfig: importPiLegacyConfig,
      dismissLegacyImport: dismissPiLegacyImport,
      importLegacyConfiguration: ({ importAuth, importModels }) => importLegacyPiConfiguration(importAuth, importModels),
      startOAuthFlow: startPiOAuthFlow,
      submitOAuthFlowInput: submitPiOAuthFlowInput,
      cancelOAuthFlow: cancelPiOAuthFlow,
      dismissOAuthFlow: dismissPiOAuthFlow,
    },
    remoteAccess: {
      getStatus: getRemoteAccessStatus,
      updateSettings: updateRemoteAccessSettings,
      createPairingCode: createRemotePairingCode,
      revokeDevice: revokeRemoteDevice,
    },
  };
}
