import { describe, expect, test } from "vitest";

import { hostedWebClientShouldDeliverLiveNotification } from "../src/lib/orchestraData/notifications";
import type { OrchestraClientBootstrap } from "../src/lib/orchestraClient";
import type { RemoteWebPushState } from "../src/lib/webPush";

const hostedWebBootstrap = {
  hostKind: "remote_api",
  authMode: "same_origin_cookie",
} as OrchestraClientBootstrap;

const desktopBootstrap = {
  hostKind: "tauri",
  authMode: "desktop_session",
} as OrchestraClientBootstrap;

function remoteWebPushState(status: RemoteWebPushState["status"]): RemoteWebPushState {
  return { status, detail: null };
}

describe("notification routing", () => {
  test("suppresses hosted-web live notifications whenever web push is subscribed", () => {
    expect(hostedWebClientShouldDeliverLiveNotification({
      bootstrap: hostedWebBootstrap,
      remoteWebPushState: remoteWebPushState("subscribed"),
      visibilityState: "visible",
      hasFocus: true,
    })).toBe(false);
  });

  test("suppresses hosted-web live notifications while backgrounded when web push is subscribed", () => {
    expect(hostedWebClientShouldDeliverLiveNotification({
      bootstrap: hostedWebBootstrap,
      remoteWebPushState: remoteWebPushState("subscribed"),
      visibilityState: "hidden",
      hasFocus: false,
    })).toBe(false);
  });

  test("falls back to live hosted-web notifications when web push is not subscribed", () => {
    expect(hostedWebClientShouldDeliverLiveNotification({
      bootstrap: hostedWebBootstrap,
      remoteWebPushState: remoteWebPushState("permission_required"),
      visibilityState: "hidden",
      hasFocus: false,
    })).toBe(true);
  });

  test("does not suppress desktop notifications", () => {
    expect(hostedWebClientShouldDeliverLiveNotification({
      bootstrap: desktopBootstrap,
      remoteWebPushState: remoteWebPushState("subscribed"),
      visibilityState: "hidden",
      hasFocus: false,
    })).toBe(true);
  });
});
