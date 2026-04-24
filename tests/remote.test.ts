import { beforeEach, describe, expect, test, vi } from "vitest";

const invokeMock = vi.fn();
let tauriAvailable = false;

function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/tauri")>("../src/lib/tauri");
  return {
    ...actual,
    isTauriAvailable: () => tauriAvailable,
  };
});

describe("remote access helpers", () => {
  beforeEach(() => {
    tauriAvailable = false;
    invokeMock.mockReset();
    const localStorage = createStorage();
    vi.stubGlobal("window", {
      localStorage,
    });
  });

  test("mock remote settings can be enabled and produce a pairing code", async () => {
    const { createRemotePairingCode, getRemoteAccessStatus, updateRemoteAccessSettings } = await import("../src/lib/remote");

    const initial = await getRemoteAccessStatus();
    expect(initial.settings.enabled).toBe(false);

    const updated = await updateRemoteAccessSettings({
      enabled: true,
      useTailscale: true,
      bindHost: "0.0.0.0",
      port: 49500,
    });

    expect(updated.settings.enabled).toBe(true);
    expect(updated.settings.useTailscale).toBe(true);
    expect(updated.settings.baseUrl).toContain("127.0.0.1:49500");
    expect(updated.settings.tailscaleWebUrl).toContain(":49500");

    const pairingCode = await createRemotePairingCode();
    expect(pairingCode.displayCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const refreshed = await getRemoteAccessStatus();
    expect(refreshed.pairingCodes).toHaveLength(1);
  });

  test("tauri mode calls the remote access commands", async () => {
    tauriAvailable = true;
    invokeMock.mockResolvedValue({ ok: true });
    const { getRemoteAccessStatus, updateRemoteAccessSettings } = await import("../src/lib/remote");

    await getRemoteAccessStatus();
    expect(invokeMock).toHaveBeenCalledWith("get_remote_access_status");

    await updateRemoteAccessSettings({ enabled: true, useTailscale: true, bindHost: "0.0.0.0", port: 49500 });
    expect(invokeMock).toHaveBeenCalledWith("update_remote_access_settings", {
      input: { enabled: true, useTailscale: true, bindHost: "0.0.0.0", port: 49500 },
    });
  });
});
