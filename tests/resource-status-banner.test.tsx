import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResourceStatusBanner } from "../src/components/ResourceStatusBanner";
import type { OrchestraConnectionSnapshot } from "../src/lib/orchestraClient";

function createConnection(): OrchestraConnectionSnapshot {
  return {
    hostState: "online",
    liveState: "connected",
    degraded: false,
    retrying: false,
    retryAttempt: 0,
    lastTransitionAt: "2026-04-30T00:00:00.000Z",
    lastError: null,
  };
}

describe("ResourceStatusBanner", () => {
  it("keeps background refreshing status out of the visible layout", () => {
    const markup = renderToString(
      <ResourceStatusBanner
        connection={createConnection()}
        hasData
        refreshing
        refreshingLabel="Refreshing task data…"
        dataRolePrefix="tasks-status"
      />,
    );

    expect(markup).not.toContain("tasks-status-refreshing\"");
    expect(markup).toContain("tasks-status-refreshing-live");
    expect(markup).toContain("visually-hidden");
    expect(markup).toContain("Refreshing task data…");
  });

  it("still renders visible error banners", () => {
    const markup = renderToString(
      <ResourceStatusBanner
        connection={createConnection()}
        hasData
        error={{
          title: "Unable to load tasks",
          message: "The last refresh failed.",
          retryable: true,
          detail: null,
        }}
        dataRolePrefix="tasks-status"
      />,
    );

    expect(markup).toContain("tasks-status-error");
    expect(markup).toContain("Unable to load tasks");
    expect(markup).toContain("Showing the last loaded data while you retry.");
  });
});
