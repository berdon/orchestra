import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { HarnessPanel } from "../src/settings/HarnessPanel";
import type { PiRuntimeDiagnostics, PiSetupState } from "../src/types";

function createSetupState(): PiSetupState {
  return {
    status: "invalid",
    agentDir: "/mock/.orchestra/runtime/pi/agent",
    authPath: "/mock/.orchestra/runtime/pi/agent/auth.json",
    modelsPath: "/mock/.orchestra/runtime/pi/agent/models.json",
    settingsPath: "/mock/.orchestra/runtime/pi/agent/settings.json",
    legacyAgentDir: "/mock/.pi/agent",
    availableProviders: [],
    availableModels: [],
    issues: [
      {
        code: "package_sources_require_bun",
        message:
          "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Install Bun or remove those package sources in Settings → Harness. Detected source: /mock/.orchestra/runtime/pi/agent/settings.json [npm:pi-subagents].",
        sourceKind: "runtime_settings_packages",
        sourcePath: "/mock/.orchestra/runtime/pi/agent/settings.json",
        sourceEntries: ["npm:pi-subagents"],
      },
    ],
    warnings: [],
    importState: {
      canImportLegacy: false,
      importedAt: null,
      dismissedAt: null,
    },
    packageDiagnostics: {
      bun: {
        available: false,
        path: null,
        message: "Bun is not available on the PATH Orchestra uses for runtime subprocesses.",
      },
      sources: [
        {
          sourceKind: "runtime_settings_packages",
          sourceScope: "runtime_owned",
          sourcePath: "/mock/.orchestra/runtime/pi/agent/settings.json",
          entries: ["npm:pi-subagents"],
          active: true,
        },
      ],
      blocking: true,
      packageFreeProbeSucceeded: false,
      packageFreeModelCount: 0,
      message:
        "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Install Bun or remove those package sources in Settings → Harness.",
    },
  };
}

function createRuntimeDiagnostics(): PiRuntimeDiagnostics {
  return {
    runtime: {
      available: true,
      source: "bundled",
      packagedMode: true,
      resolvedPath: "/mock/pi",
      error: null,
      message: "Pi runtime resolved from bundled at /mock/pi.",
    },
    auth: {
      configured: true,
      agentDir: "/mock/.orchestra/runtime/pi/agent",
      authPath: "/mock/.orchestra/runtime/pi/agent/auth.json",
      modelsPath: "/mock/.orchestra/runtime/pi/agent/models.json",
      settingsPath: "/mock/.orchestra/runtime/pi/agent/settings.json",
      authExists: true,
      modelsExists: true,
      legacyAgentDir: "/mock/.pi/agent",
      legacyAuthAvailable: false,
      legacyModelsAvailable: false,
      authImportedAt: null,
      modelsImportedAt: null,
      message: "Orchestra is using auth.json and models.json from /mock/.orchestra/runtime/pi/agent.",
    },
    addOns: {
      packagedMode: true,
      allowed: true,
      extraExtensions: [],
      blockedExtensions: [],
      message: "Packaged mode allows only explicit local filesystem paths for extra Pi runtime extensions.",
    },
  };
}

describe("HarnessPanel package diagnostics", () => {
  test("renders Bun status and concrete package source details", () => {
    const markup = renderToString(
      <HarnessPanel
        piSetupState={createSetupState()}
        piOAuthFlowState={null}
        piModelsJson={'{\n  "providers": {}\n}\n'}
        loadingPiSetup={false}
        loadingPiModelsJson={false}
        onRefresh={() => {}}
        onSaveProviderApiKey={async () => {}}
        onRemoveProviderCredential={async () => {}}
        onStartOAuthFlow={async () => {}}
        onSubmitOAuthFlowInput={async () => {}}
        onCancelOAuthFlow={async () => {}}
        onDismissOAuthFlow={async () => {}}
        onImportLegacyConfig={async () => {}}
        onDismissLegacyImport={async () => {}}
        onSaveModelsJson={async () => {}}
        piRuntimeSettings={{
          extraExtensions: [],
          defaultCompactionWindow: "10%",
          updatedAt: null,
        }}
        piRuntimeDiagnostics={createRuntimeDiagnostics()}
        onSavePiRuntimeSettings={() => {}}
        onImportLegacyPiConfiguration={() => {}}
      />,
    );

    expect(markup).toContain("Package source + Bun status");
    expect(markup).toContain("Bun is not available on the PATH Orchestra uses for runtime subprocesses.");
    expect(markup).toContain("/mock/.orchestra/runtime/pi/agent/settings.json");
    expect(markup).toContain("npm:pi-subagents");
    expect(markup).toContain("Settings → Harness");
  });
});
