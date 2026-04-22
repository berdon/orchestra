#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "tests", "desktop-e2e-suite.json");

function readSuiteConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return {
    directory: parsed.directory ?? "tests/desktop-e2e",
    quarantined: Array.isArray(parsed.quarantined) ? parsed.quarantined : [],
  };
}

function normalizeQuarantineEntry(entry) {
  if (typeof entry === "string") {
    return { path: entry, reason: "" };
  }
  if (entry && typeof entry === "object" && typeof entry.path === "string") {
    return {
      path: entry.path,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    };
  }
  throw new Error(`Invalid desktop E2E quarantine entry in ${CONFIG_PATH}: ${JSON.stringify(entry)}`);
}

export function getDesktopE2ESuiteManifest() {
  const config = readSuiteConfig();
  const suiteDirectoryPath = path.join(ROOT_DIR, config.directory);
  const discovered = fs.readdirSync(suiteDirectoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.posix.join(config.directory, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const quarantineEntries = config.quarantined.map(normalizeQuarantineEntry);
  const quarantinePaths = new Set(quarantineEntries.map((entry) => entry.path));

  for (const entry of quarantineEntries) {
    if (!discovered.includes(entry.path)) {
      throw new Error(`Desktop E2E quarantine entry does not match a discovered spec: ${entry.path}`);
    }
  }

  return {
    directory: config.directory,
    discovered,
    quarantined: quarantineEntries,
    included: discovered.filter((file) => !quarantinePaths.has(file)),
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
