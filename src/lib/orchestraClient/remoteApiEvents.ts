import type {
  InboxChangeEvent,
  NotificationIntent,
  RemoteEventEnvelope,
  SessionChangeEvent,
  SessionStreamEnvelope,
  TaskChangeEvent,
} from "../../types";
import type { OrchestraClientBootstrap } from "./bootstrap";
import type { OrchestraConnectionController } from "./connection";
import {
  normalizeOrchestraClientError,
  type OrchestraClientError,
  type OrchestraClientErrorCode,
} from "./errors";
import type { OrchestraClientEventHandler, OrchestraUnsubscribe } from "./events";
import {
  toOrchestraInboxChangeDelivery,
  toOrchestraNotificationIntentDelivery,
  toOrchestraSessionChangeDelivery,
  toOrchestraSessionStreamDelivery,
  toOrchestraTaskChangeDelivery,
} from "./events";
import type {
  RemoteApiOrchestraClientOptions,
  RemoteApiTransport,
} from "./remoteApiTransport";

type PendingConnection = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type PendingSessionConfirmation = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type RemoteSocketIncomingMessage =
  | {
      type: "connected";
      contractVersion?: string;
    }
  | {
      type: "subscription.confirmed";
      subscriptionType?: string;
      sessionId?: string;
      subscribed?: boolean;
    }
  | {
      type: "event";
      event?: RemoteEventEnvelope;
    }
  | {
      type: "error";
      error?: string;
    }
  | {
      type: "pong";
    };

function normalizeRemoteTopic(topic: string) {
  switch (topic) {
    case "task.updated":
    case "task.change":
      return "task.change" as const;
    case "session.updated":
    case "session.change":
      return "session.change" as const;
    case "inbox.updated":
    case "inbox.change":
      return "inbox.change" as const;
    case "session.stream":
      return "session.stream" as const;
    case "notification.intent":
      return "notification.intent" as const;
    default:
      return null;
  }
}

function classifySocketErrorCode(message: string): OrchestraClientErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("offline") || normalized.includes("failed to fetch") || normalized.includes("network")) {
    return "offline";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "timeout";
  }
  if (normalized.includes("forbidden")) {
    return "forbidden";
  }
  if (normalized.includes("unauthorized") || normalized.includes("authentication") || normalized.includes("auth")) {
    return "unauthorized";
  }
  return "transport";
}

function isSessionConfirmationKey(sessionId: string, subscribed: boolean) {
  return `${sessionId}:${subscribed ? "subscribed" : "unsubscribed"}`;
}

function getReconnectDelayMs(retryAttempt: number) {
  const boundedAttempt = Math.max(1, retryAttempt);
  return Math.min(250 * (2 ** (boundedAttempt - 1)), 5_000);
}

export class RemoteApiEventManager {
  private readonly bootstrap: OrchestraClientBootstrap;
  private readonly transport: RemoteApiTransport;
  private readonly connectionController: OrchestraConnectionController;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly handlers = new Set<OrchestraClientEventHandler>();
  private readonly activeSessionSubscriptions = new Set<string>();
  private readonly pendingSessionConfirmations = new Map<string, PendingSessionConfirmation[]>();
  private readonly browserOnlineListener?: () => void;
  private readonly browserOfflineListener?: () => void;
  private readonly visibilityChangeListener?: () => void;
  private readonly focusListener?: () => void;
  private readonly blurListener?: () => void;
  private readonly pageShowListener?: () => void;
  private readonly pageHideListener?: () => void;
  private socket: WebSocket | null = null;
  private pendingConnection: PendingConnection | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceHeartbeatTimer: number | null = null;
  private sawConnectedFrame = false;
  private intentionallyClosed = false;
  private lastSentForegrounded: boolean | null = null;

  constructor(
    transport: RemoteApiTransport,
    bootstrap: OrchestraClientBootstrap,
    connectionController: OrchestraConnectionController,
    options?: RemoteApiOrchestraClientOptions,
  ) {
    this.transport = transport;
    this.bootstrap = bootstrap;
    this.connectionController = connectionController;
    this.webSocketFactory = options?.webSocketFactory ?? ((url) => new WebSocket(url));

    if (typeof window !== "undefined") {
      this.browserOnlineListener = () => {
        this.connectionController.markHostOnline();
        if (this.shouldKeepSocketAlive() && !this.socket) {
          this.scheduleReconnect(undefined, true);
        }
      };
      this.browserOfflineListener = () => {
        const error = this.createSocketError("events.subscribe", "Browser network connectivity is offline.", "offline");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.intentionallyClosed = true;
        this.pendingConnection?.reject(error);
        this.rejectAllPendingSessionConfirmations(error);
        if (this.socket) {
          this.socket.close();
        }
        this.socket = null;
        this.sawConnectedFrame = false;
        this.connectionController.markHostOffline(error);
      };
      this.visibilityChangeListener = () => {
        this.sendPresenceUpdate();
      };
      this.focusListener = () => {
        this.sendPresenceUpdate();
      };
      this.blurListener = () => {
        this.sendPresenceUpdate();
      };
      this.pageShowListener = () => {
        this.sendPresenceUpdate(true);
      };
      this.pageHideListener = () => {
        this.sendPresenceUpdate(true, false);
      };
      window.addEventListener("online", this.browserOnlineListener);
      window.addEventListener("offline", this.browserOfflineListener);
      window.addEventListener("focus", this.focusListener);
      window.addEventListener("blur", this.blurListener);
      window.addEventListener("pageshow", this.pageShowListener);
      window.addEventListener("pagehide", this.pageHideListener);
      document.addEventListener("visibilitychange", this.visibilityChangeListener);
    }
  }

  async subscribe(handler: OrchestraClientEventHandler): Promise<OrchestraUnsubscribe> {
    this.transport.assertCapability("events.subscribe", this.bootstrap.capabilities.sessions.stream);
    this.handlers.add(handler);
    await this.ensureConnected("events.subscribe");
    return () => {
      this.handlers.delete(handler);
      this.maybeCloseIdleSocket();
    };
  }

  async confirmSessionSubscription(sessionId: string, subscribed: boolean): Promise<void> {
    this.transport.assertCapability(
      subscribed ? "sessions.subscribe" : "sessions.unsubscribe",
      this.bootstrap.capabilities.sessions.stream,
    );
    await this.ensureConnected(subscribed ? "sessions.subscribe" : "sessions.unsubscribe");
    await this.sendSessionSubscriptionMessage(sessionId, subscribed);
    if (subscribed) {
      this.activeSessionSubscriptions.add(sessionId);
    } else {
      this.activeSessionSubscriptions.delete(sessionId);
      this.maybeCloseIdleSocket();
    }
  }

  private async ensureConnected(operation: string): Promise<void> {
    if (this.socket && this.sawConnectedFrame) {
      return;
    }

    if (this.pendingConnection) {
      return new Promise((resolve, reject) => {
        const current = this.pendingConnection;
        if (!current) {
          resolve();
          return;
        }
        const timeoutId = setTimeout(() => {
          reject(this.createSocketError(operation, "Timed out while waiting for the remote WebSocket connection.", "timeout"));
        }, 5_000);
        const originalResolve = current.resolve;
        const originalReject = current.reject;
        current.resolve = () => {
          clearTimeout(timeoutId);
          originalResolve();
          resolve();
        };
        current.reject = (error) => {
          clearTimeout(timeoutId);
          originalReject(error);
          reject(error);
        };
      });
    }

    const websocketUrl = this.transport.getWebSocketUrl(operation);
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(websocketUrl);
    } catch (error) {
      const normalized = this.createSocketError(operation, error);
      this.connectionController.markLiveState("disconnected", { retrying: false, lastError: normalized });
      throw normalized;
    }

    this.intentionallyClosed = false;
    this.sawConnectedFrame = false;
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingConnection = null;
        const timeoutError = this.createSocketError(operation, "Timed out while waiting for the remote WebSocket connection.", "timeout");
        this.connectionController.markLiveState("disconnected", { retrying: false, lastError: timeoutError });
        reject(timeoutError);
      }, 5_000);
      this.pendingConnection = {
        resolve: () => {
          clearTimeout(timeoutId);
          this.pendingConnection = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          this.pendingConnection = null;
          reject(error);
        },
        timeoutId,
      };

      socket.onopen = () => {
        this.connectionController.markHostOnline();
      };
      socket.onmessage = (event) => {
        void this.handleSocketMessage(event.data, operation);
      };
      socket.onerror = () => {
        if (this.pendingConnection) {
          const normalized = this.createSocketError(operation, "Remote WebSocket connection failed.");
          this.connectionController.markLiveState("disconnected", { retrying: false, lastError: normalized });
          this.pendingConnection.reject(normalized);
        }
      };
      socket.onclose = () => {
        this.handleSocketClosed(operation);
      };
    });
  }

  private handleSocketClosed(operation: string) {
    const wasIntentional = this.intentionallyClosed;
    this.stopPresenceHeartbeat();
    this.socket = null;
    this.sawConnectedFrame = false;
    this.lastSentForegrounded = null;
    const error = this.createSocketError(operation, "Remote WebSocket connection closed.");
    if (this.pendingConnection) {
      this.pendingConnection.reject(error);
    }
    this.rejectAllPendingSessionConfirmations(error);

    if (wasIntentional && !this.shouldKeepSocketAlive()) {
      this.connectionController.markConnected();
      return;
    }

    if (!wasIntentional && this.shouldKeepSocketAlive() && this.connectionController.getSnapshot().hostState === "online") {
      this.scheduleReconnect(error);
      return;
    }

    if (!wasIntentional) {
      this.connectionController.markLiveState("disconnected", { retrying: false, lastError: error });
    }
  }

  private scheduleReconnect(lastError?: OrchestraClientError, immediate = false) {
    if (this.reconnectTimer) {
      return;
    }
    const nextAttempt = (this.connectionController.getSnapshot().retryAttempt || 0) + 1;
    const delayMs = immediate ? 0 : getReconnectDelayMs(nextAttempt);
    this.connectionController.markReconnecting(nextAttempt, lastError ?? null);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected("events.subscribe").catch((error) => {
        const normalized = this.createSocketError("events.subscribe", error, classifySocketErrorCode(error instanceof Error ? error.message : String(error)));
        if (this.connectionController.getSnapshot().hostState === "online" && this.shouldKeepSocketAlive()) {
          this.scheduleReconnect(normalized);
        } else {
          this.connectionController.markLiveState("disconnected", { retrying: false, lastError: normalized });
        }
      });
    }, delayMs);
  }

  private shouldKeepSocketAlive() {
    return this.handlers.size > 0 || this.activeSessionSubscriptions.size > 0;
  }

  private computeForegrounded() {
    if (typeof document === "undefined") {
      return true;
    }
    const isVisible = document.visibilityState === "visible";
    const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    return isVisible && hasFocus;
  }

  private sendPresenceUpdate(force = false, foregroundedOverride?: boolean) {
    if (!this.socket || !this.sawConnectedFrame || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const foregrounded = foregroundedOverride ?? this.computeForegrounded();
    if (!force && this.lastSentForegrounded === foregrounded) {
      return;
    }
    this.lastSentForegrounded = foregrounded;
    try {
      this.socket.send(JSON.stringify({
        type: "client.presence",
        foregrounded,
      }));
    } catch {
      // best effort presence hint for notification routing
    }
  }

  private startPresenceHeartbeat() {
    if (typeof window === "undefined" || this.presenceHeartbeatTimer) {
      return;
    }
    this.presenceHeartbeatTimer = window.setInterval(() => {
      this.sendPresenceUpdate(true);
    }, 20_000);
  }

  private stopPresenceHeartbeat() {
    if (this.presenceHeartbeatTimer) {
      clearInterval(this.presenceHeartbeatTimer);
      this.presenceHeartbeatTimer = null;
    }
  }

  private maybeCloseIdleSocket() {
    if (this.shouldKeepSocketAlive()) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) {
      this.connectionController.markConnected();
      return;
    }
    this.intentionallyClosed = true;
    this.stopPresenceHeartbeat();
    this.socket.close();
    this.socket = null;
    this.sawConnectedFrame = false;
    this.lastSentForegrounded = null;
    this.connectionController.markConnected();
  }

  private async handleSocketMessage(rawData: unknown, operation: string) {
    if (typeof rawData !== "string") {
      const error = this.createSocketError(operation, "Remote WebSocket delivered a non-text frame.");
      this.connectionController.markLiveState("disconnected", { retrying: false, lastError: error });
      this.rejectAllPendingSessionConfirmations(error);
      return;
    }

    let message: RemoteSocketIncomingMessage;
    try {
      message = JSON.parse(rawData) as RemoteSocketIncomingMessage;
    } catch (error) {
      const normalized = this.createSocketError(operation, error);
      if (this.pendingConnection) {
        this.pendingConnection.reject(normalized);
      }
      this.connectionController.markLiveState("disconnected", { retrying: false, lastError: normalized });
      this.rejectAllPendingSessionConfirmations(normalized);
      return;
    }

    switch (message.type) {
      case "connected": {
        if (message.contractVersion && message.contractVersion !== this.bootstrap.contractVersion) {
          const error = this.createSocketError(
            operation,
            `Remote WebSocket contract mismatch. Expected ${this.bootstrap.contractVersion} but received ${message.contractVersion}.`,
            "unsupported",
          );
          if (this.pendingConnection) {
            this.pendingConnection.reject(error);
          }
          this.connectionController.markLiveState("disconnected", { retrying: false, lastError: error });
          this.rejectAllPendingSessionConfirmations(error);
          this.intentionallyClosed = true;
          this.socket?.close();
          return;
        }
        this.sawConnectedFrame = true;
        this.connectionController.markHostOnline();
        this.connectionController.markConnected();
        if (this.pendingConnection) {
          this.pendingConnection.resolve();
        }
        this.sendPresenceUpdate(true);
        this.startPresenceHeartbeat();
        this.replaySessionSubscriptions();
        return;
      }
      case "subscription.confirmed": {
        if (message.subscriptionType !== "session" || !message.sessionId || typeof message.subscribed !== "boolean") {
          return;
        }
        const key = isSessionConfirmationKey(message.sessionId, message.subscribed);
        const queue = this.pendingSessionConfirmations.get(key);
        const pending = queue?.shift();
        if (queue && queue.length === 0) {
          this.pendingSessionConfirmations.delete(key);
        }
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeoutId);
        pending.resolve();
        return;
      }
      case "event": {
        if (!message.event) {
          return;
        }
        this.deliverEnvelope(message.event);
        return;
      }
      case "error": {
        const error = this.createSocketError(operation, message.error ?? "Remote WebSocket reported an error.", classifySocketErrorCode(message.error ?? ""));
        if (this.pendingConnection) {
          this.pendingConnection.reject(error);
        }
        this.connectionController.markLiveState("disconnected", { retrying: false, lastError: error });
        this.rejectAllPendingSessionConfirmations(error);
        return;
      }
      case "pong":
        return;
      default:
        return;
    }
  }

  private deliverEnvelope(envelope: RemoteEventEnvelope) {
    const normalizedTopic = normalizeRemoteTopic(envelope.topic);
    if (!normalizedTopic) {
      return;
    }

    switch (normalizedTopic) {
      case "task.change": {
        const payload = envelope.payload as unknown as TaskChangeEvent;
        for (const handler of this.handlers) {
          handler(toOrchestraTaskChangeDelivery(payload));
        }
        return;
      }
      case "session.change": {
        const payload = envelope.payload as unknown as SessionChangeEvent;
        for (const handler of this.handlers) {
          handler(toOrchestraSessionChangeDelivery(payload));
        }
        return;
      }
      case "inbox.change": {
        const payload = envelope.payload as unknown as InboxChangeEvent;
        for (const handler of this.handlers) {
          handler(toOrchestraInboxChangeDelivery(payload));
        }
        return;
      }
      case "session.stream": {
        const payload = envelope.payload as unknown as SessionStreamEnvelope;
        if (!this.activeSessionSubscriptions.has(payload.sessionId)) {
          return;
        }
        for (const handler of this.handlers) {
          handler(toOrchestraSessionStreamDelivery(payload));
        }
        return;
      }
      case "notification.intent": {
        const payload = envelope.payload as unknown as NotificationIntent;
        for (const handler of this.handlers) {
          handler(toOrchestraNotificationIntentDelivery(payload));
        }
        return;
      }
    }
  }

  private async sendSessionSubscriptionMessage(sessionId: string, subscribed: boolean) {
    if (!this.socket || !this.sawConnectedFrame) {
      throw this.createSocketError(
        subscribed ? "sessions.subscribe" : "sessions.unsubscribe",
        "Remote WebSocket is not connected.",
      );
    }

    const key = isSessionConfirmationKey(sessionId, subscribed);
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const queue = this.pendingSessionConfirmations.get(key);
        if (queue) {
          this.pendingSessionConfirmations.set(
            key,
            queue.filter((entry) => entry.timeoutId !== timeoutId),
          );
          if ((this.pendingSessionConfirmations.get(key)?.length ?? 0) === 0) {
            this.pendingSessionConfirmations.delete(key);
          }
        }
        reject(this.createSocketError(
          subscribed ? "sessions.subscribe" : "sessions.unsubscribe",
          `Timed out while waiting for remote ${subscribed ? "subscribe" : "unsubscribe"} confirmation for session ${sessionId}.`,
          "timeout",
        ));
      }, 5_000);

      const queue = this.pendingSessionConfirmations.get(key) ?? [];
      queue.push({ resolve, reject, timeoutId });
      this.pendingSessionConfirmations.set(key, queue);

      this.socket?.send(JSON.stringify({
        type: subscribed ? "session.subscribe" : "session.unsubscribe",
        sessionId,
      }));
    });
  }

  private replaySessionSubscriptions() {
    if (!this.socket || !this.sawConnectedFrame) {
      return;
    }
    for (const sessionId of this.activeSessionSubscriptions) {
      this.socket.send(JSON.stringify({
        type: "session.subscribe",
        sessionId,
      }));
    }
  }

  private rejectAllPendingSessionConfirmations(error: Error) {
    for (const entries of this.pendingSessionConfirmations.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timeoutId);
        entry.reject(error);
      }
    }
    this.pendingSessionConfirmations.clear();
  }

  private createSocketError(
    operation: string,
    error: unknown,
    code: OrchestraClientErrorCode = "transport",
  ) {
    return normalizeOrchestraClientError(error, {
      operation,
      source: "remote_api",
      fallbackMessage: `Remote WebSocket transport failed during ${operation}.`,
      code,
      details: {
        authMode: this.bootstrap.authMode,
        websocketUrl: this.bootstrap.urls.websocketUrl,
      },
    });
  }

  destroy() {
    this.stopPresenceHeartbeat();
    if (this.browserOnlineListener) {
      window.removeEventListener("online", this.browserOnlineListener);
    }
    if (this.browserOfflineListener) {
      window.removeEventListener("offline", this.browserOfflineListener);
    }
    if (this.focusListener) {
      window.removeEventListener("focus", this.focusListener);
    }
    if (this.blurListener) {
      window.removeEventListener("blur", this.blurListener);
    }
    if (this.pageShowListener) {
      window.removeEventListener("pageshow", this.pageShowListener);
    }
    if (this.pageHideListener) {
      window.removeEventListener("pagehide", this.pageHideListener);
    }
    if (this.visibilityChangeListener) {
      document.removeEventListener("visibilitychange", this.visibilityChangeListener);
    }
  }
}
