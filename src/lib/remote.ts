import { invoke } from "@tauri-apps/api/core";

import {
  buildExampleRemoteLanBaseUrl,
  buildExampleRemoteSecureBaseUrl,
} from "./exampleRemoteEndpoints";
import { isTauriAvailable } from "./tauri";
import type {
  RemoteAccessSettingsInput,
  RemoteAccessStatus,
  RemoteDeviceRecord,
  RemotePairingCode,
  RemotePairingCodeInput,
} from "../types";

const REMOTE_STATUS_STORAGE_KEY = "orchestra.mock.remote-status";

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function getStoredStatus(): RemoteAccessStatus {
  const existing = window.localStorage.getItem(REMOTE_STATUS_STORAGE_KEY);
  if (existing) {
    return JSON.parse(existing) as RemoteAccessStatus;
  }

  const seeded: RemoteAccessStatus = {
    settings: {
      enabled: false,
      useTailscale: false,
      bindHost: "0.0.0.0",
      port: 49500,
      baseUrl: null,
      websocketUrl: null,
      lanBaseUrl: null,
      webUrl: null,
      tailscaleUrl: null,
      tailscaleWebUrl: null,
      startedAt: null,
      lastError: null,
    },
    pairingCodes: [],
    devices: [],
    activeClients: [],
  };
  window.localStorage.setItem(REMOTE_STATUS_STORAGE_KEY, JSON.stringify(seeded));
  return seeded;
}

function saveStoredStatus(status: RemoteAccessStatus) {
  window.localStorage.setItem(REMOTE_STATUS_STORAGE_KEY, JSON.stringify(status));
}

export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  if (!isTauriAvailable()) {
    return getStoredStatus();
  }
  return invoke<RemoteAccessStatus>("get_remote_access_status");
}

export async function updateRemoteAccessSettings(input: RemoteAccessSettingsInput): Promise<RemoteAccessStatus> {
  if (!isTauriAvailable()) {
    const current = getStoredStatus();
    const next: RemoteAccessStatus = {
      ...current,
      settings: {
        ...current.settings,
        enabled: input.enabled,
        useTailscale: input.useTailscale,
        bindHost: input.useTailscale ? "127.0.0.1" : (input.bindHost?.trim() || current.settings.bindHost),
        port: input.port ?? current.settings.port,
        baseUrl: input.enabled ? `http://127.0.0.1:${input.port ?? current.settings.port}` : null,
        websocketUrl: input.enabled ? `ws://127.0.0.1:${input.port ?? current.settings.port}/api/v1/ws` : null,
        lanBaseUrl: input.enabled && !input.useTailscale ? buildExampleRemoteLanBaseUrl(input.port ?? current.settings.port) : null,
        webUrl: input.enabled ? `http://127.0.0.1:${input.port ?? current.settings.port}` : null,
        tailscaleUrl: input.enabled && input.useTailscale ? buildExampleRemoteSecureBaseUrl(input.port ?? current.settings.port) : null,
        tailscaleWebUrl: input.enabled && input.useTailscale ? buildExampleRemoteSecureBaseUrl(input.port ?? current.settings.port) : null,
        startedAt: input.enabled ? nowIso() : null,
        lastError: null,
      },
    };
    saveStoredStatus(next);
    return next;
  }
  return invoke<RemoteAccessStatus>("update_remote_access_settings", { input });
}

export async function createRemotePairingCode(input?: RemotePairingCodeInput | null): Promise<RemotePairingCode> {
  if (!isTauriAvailable()) {
    const current = getStoredStatus();
    const code = `${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const pairing: RemotePairingCode = {
      id: createId("pair"),
      code,
      displayCode: code,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      consumedAt: null,
    };
    saveStoredStatus({
      ...current,
      pairingCodes: [pairing, ...current.pairingCodes],
    });
    void input;
    return pairing;
  }
  return invoke<RemotePairingCode>("create_remote_pairing_code", { input });
}

export async function revokeRemoteDevice(deviceId: string): Promise<RemoteDeviceRecord> {
  if (!isTauriAvailable()) {
    const current = getStoredStatus();
    const nextDevices = current.devices.map((device) =>
      device.id === deviceId
        ? { ...device, revokedAt: nowIso(), activeClientCount: 0 }
        : device,
    );
    const updated = nextDevices.find((device) => device.id === deviceId);
    if (!updated) {
      throw new Error(`Remote device ${deviceId} was not found.`);
    }
    saveStoredStatus({
      ...current,
      devices: nextDevices,
      activeClients: current.activeClients.filter((client) => client.deviceId !== deviceId),
    });
    return updated;
  }
  return invoke<RemoteDeviceRecord>("revoke_remote_device", { deviceId });
}
