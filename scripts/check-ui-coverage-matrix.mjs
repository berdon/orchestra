#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDesktopE2ESuiteManifest } from "./desktop-e2e-suite.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const MATRIX_PATH = path.join(ROOT_DIR, "tests", "ui-coverage-matrix.json");

function detectHarness(specPath) {
  if (specPath.startsWith("tests/desktop-e2e/")) {
    return "desktop";
  }
  if (specPath.startsWith("tests/e2e/")) {
    return "browser";
  }
  if (specPath.startsWith("tests/web-driver-e2e/")) {
    return "web-driver";
  }
  throw new Error(`Unsupported UI coverage spec path: ${specPath}`);
}

function loadMatrix() {
  return JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
}

function discoverSuiteInventory() {
  const desktopManifest = getDesktopE2ESuiteManifest();
  const browser = fs.readdirSync(path.join(ROOT_DIR, "tests", "e2e"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => path.posix.join("tests/e2e", entry.name));
  const webDriver = fs.readdirSync(path.join(ROOT_DIR, "tests", "web-driver-e2e"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => path.posix.join("tests/web-driver-e2e", entry.name));

  return {
    browser: new Set(browser),
    desktop: new Set(desktopManifest.included),
    "web-driver": new Set(webDriver),
  };
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function main() {
  const matrix = loadMatrix();
  const inventory = discoverSuiteInventory();
  const journeys = Array.isArray(matrix.journeys) ? matrix.journeys : [];
  const thresholdPercent = Number(matrix.thresholdPercent ?? 90);
  const errors = [];

  let covered = 0;
  const surfaceCounts = new Map();

  for (const journey of journeys) {
    if (!journey || typeof journey !== "object") {
      errors.push(`Invalid journey entry: ${JSON.stringify(journey)}`);
      continue;
    }

    const journeyId = typeof journey.id === "string" ? journey.id : "unknown-id";
    const surface = typeof journey.surface === "string" ? journey.surface : "Unknown";
    const status = typeof journey.status === "string" ? journey.status : "missing";
    const specs = Array.isArray(journey.specs) ? journey.specs : [];
    const requiredHarnesses = Array.isArray(journey.requiredHarnesses) ? journey.requiredHarnesses : [];

    surfaceCounts.set(surface, surfaceCounts.get(surface) ?? { total: 0, covered: 0 });
    surfaceCounts.get(surface).total += 1;

    const harnessCoverage = new Set();

    for (const specPath of specs) {
      if (typeof specPath !== "string") {
        errors.push(`[${journeyId}] Non-string spec path: ${JSON.stringify(specPath)}`);
        continue;
      }
      const absolutePath = path.join(ROOT_DIR, specPath);
      if (!fs.existsSync(absolutePath)) {
        errors.push(`[${journeyId}] Missing spec file: ${specPath}`);
        continue;
      }
      const harness = detectHarness(specPath);
      harnessCoverage.add(harness);
      if (!inventory[harness]?.has(specPath)) {
        errors.push(`[${journeyId}] Spec is not part of the required ${harness} suite: ${specPath}`);
      }
    }

    for (const harness of requiredHarnesses) {
      if (!inventory[harness]) {
        errors.push(`[${journeyId}] Unknown required harness: ${harness}`);
        continue;
      }
      if (!harnessCoverage.has(harness)) {
        errors.push(`[${journeyId}] Missing mapped spec for required harness '${harness}'`);
      }
    }

    if (status === "covered") {
      covered += 1;
      surfaceCounts.get(surface).covered += 1;
    } else if (status !== "missing") {
      errors.push(`[${journeyId}] Unsupported status '${status}'. Use 'covered' or 'missing'.`);
    }
  }

  const total = journeys.length;
  const coveragePercent = total === 0 ? 0 : (covered / total) * 100;

  console.log(`UI critical-journey coverage: ${covered}/${total} (${formatPercent(coveragePercent)})`);
  console.log(`Required threshold: >= ${formatPercent(thresholdPercent)}`);
  console.log("");
  console.log("Coverage by surface:");
  for (const [surface, counts] of [...surfaceCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const surfacePercent = counts.total === 0 ? 0 : (counts.covered / counts.total) * 100;
    console.log(`- ${surface}: ${counts.covered}/${counts.total} (${formatPercent(surfacePercent)})`);
  }

  if (errors.length > 0) {
    console.error("\nUI coverage matrix validation errors:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  if (coveragePercent < thresholdPercent) {
    console.error(`\nUI critical-journey coverage ${formatPercent(coveragePercent)} is below the required ${formatPercent(thresholdPercent)} threshold.`);
    process.exit(1);
  }
}

main();
