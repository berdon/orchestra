import type { OrchestraClientBootstrap } from "./bootstrap";
import type { OrchestraClientErrorShape } from "./errors";
import type { OrchestraUnsubscribe } from "./events";

export type OrchestraHostConnectionState = "online" | "offline";
export type OrchestraLiveConnectionState = "connected" | "reconnecting" | "disconnected" | "unsupported";

export interface OrchestraConnectionSnapshot {
  hostState: OrchestraHostConnectionState;
  liveState: OrchestraLiveConnectionState;
  degraded: boolean;
  retrying: boolean;
  retryAttempt: number;
  lastTransitionAt: string;
  lastError?: OrchestraClientErrorShape | null;
}

export interface OrchestraConnectionService {
  getSnapshot(): OrchestraConnectionSnapshot;
  subscribe(handler: (snapshot: OrchestraConnectionSnapshot) => void): Promise<OrchestraUnsubscribe>;
}

function nowIso() {
  return new Date().toISOString();
}

function sameSnapshot(left: OrchestraConnectionSnapshot, right: OrchestraConnectionSnapshot) {
  return left.hostState === right.hostState
    && left.liveState === right.liveState
    && left.degraded === right.degraded
    && left.retrying === right.retrying
    && left.retryAttempt === right.retryAttempt
    && left.lastTransitionAt === right.lastTransitionAt
    && left.lastError?.code === right.lastError?.code
    && left.lastError?.message === right.lastError?.message
    && left.lastError?.operation === right.lastError?.operation
    && left.lastError?.source === right.lastError?.source;
}

export class OrchestraConnectionController implements OrchestraConnectionService {
  private snapshot: OrchestraConnectionSnapshot;
  private readonly handlers = new Set<(snapshot: OrchestraConnectionSnapshot) => void>();

  constructor(initialSnapshot: OrchestraConnectionSnapshot) {
    this.snapshot = initialSnapshot;
  }

  getSnapshot(): OrchestraConnectionSnapshot {
    return this.snapshot;
  }

  async subscribe(handler: (snapshot: OrchestraConnectionSnapshot) => void): Promise<OrchestraUnsubscribe> {
    this.handlers.add(handler);
    handler(this.snapshot);
    return () => {
      this.handlers.delete(handler);
    };
  }

  setSnapshot(snapshot: OrchestraConnectionSnapshot) {
    if (sameSnapshot(this.snapshot, snapshot)) {
      return;
    }
    this.snapshot = snapshot;
    for (const handler of this.handlers) {
      handler(snapshot);
    }
  }

  updateSnapshot(updater: (snapshot: OrchestraConnectionSnapshot) => OrchestraConnectionSnapshot) {
    this.setSnapshot(updater(this.snapshot));
  }

  markHostOnline() {
    this.updateSnapshot((snapshot) => {
      if (snapshot.hostState === "online") {
        return snapshot;
      }
      return {
        ...snapshot,
        hostState: "online",
        degraded: snapshot.liveState !== "connected" && snapshot.liveState !== "unsupported",
        lastTransitionAt: nowIso(),
      };
    });
  }

  markHostOffline(lastError?: OrchestraClientErrorShape | null) {
    this.updateSnapshot((snapshot) => ({
      ...snapshot,
      hostState: "offline",
      liveState: snapshot.liveState === "unsupported" ? "unsupported" : "disconnected",
      degraded: true,
      retrying: false,
      lastError: lastError ?? snapshot.lastError ?? null,
      lastTransitionAt: nowIso(),
    }));
  }

  markLiveState(
    liveState: OrchestraLiveConnectionState,
    options?: {
      retrying?: boolean;
      retryAttempt?: number;
      lastError?: OrchestraClientErrorShape | null;
    },
  ) {
    this.updateSnapshot((snapshot) => ({
      ...snapshot,
      liveState,
      degraded: liveState !== "connected" && liveState !== "unsupported",
      retrying: options?.retrying ?? snapshot.retrying,
      retryAttempt: options?.retryAttempt ?? snapshot.retryAttempt,
      lastError: options?.lastError ?? snapshot.lastError ?? null,
      lastTransitionAt: nowIso(),
    }));
  }

  markConnected() {
    this.updateSnapshot((snapshot) => ({
      ...snapshot,
      hostState: "online",
      liveState: snapshot.liveState === "unsupported" ? "unsupported" : "connected",
      degraded: false,
      retrying: false,
      retryAttempt: 0,
      lastTransitionAt: nowIso(),
    }));
  }

  markReconnecting(retryAttempt: number, lastError?: OrchestraClientErrorShape | null) {
    this.updateSnapshot((snapshot) => ({
      ...snapshot,
      liveState: snapshot.liveState === "unsupported" ? "unsupported" : "reconnecting",
      degraded: true,
      retrying: snapshot.liveState !== "unsupported",
      retryAttempt,
      lastError: lastError ?? snapshot.lastError ?? null,
      lastTransitionAt: nowIso(),
    }));
  }
}

export function createStaticConnectionService(snapshot: OrchestraConnectionSnapshot): OrchestraConnectionService {
  return {
    getSnapshot() {
      return snapshot;
    },
    async subscribe(handler) {
      handler(snapshot);
      return () => undefined;
    },
  };
}

export function createOptimisticConnectionSnapshot(
  bootstrap: OrchestraClientBootstrap,
): OrchestraConnectionSnapshot {
  const liveSupported = bootstrap.capabilities.sessions.stream.availability === "available";
  return {
    hostState: "online",
    liveState: liveSupported ? "connected" : "unsupported",
    degraded: false,
    retrying: false,
    retryAttempt: 0,
    lastTransitionAt: bootstrap.bootstrappedAt ?? nowIso(),
    lastError: null,
  };
}
