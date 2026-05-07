#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getE2EHarnessManifest } from "./e2e-suite.mjs";

export function getDesktopE2ESuiteManifest() {
  const suite = getE2EHarnessManifest("desktop");
  return {
    directory: suite.directory,
    discovered: suite.discovered,
    quarantined: suite.quarantined,
    included: suite.included,
  };
}

function printShellList() {
  const { included } = getDesktopE2ESuiteManifest();
  process.stdout.write(`${included.join("\n")}\n`);
}

function printJson() {
  process.stdout.write(`${JSON.stringify(getDesktopE2ESuiteManifest(), null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.includes("--json")) {
    printJson();
  } else {
    printShellList();
  }
}
