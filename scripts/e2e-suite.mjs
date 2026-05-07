#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "tests", "e2e-suite.json");

function readSuiteConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const suites = Array.isArray(parsed.suites) ? parsed.suites : [];
  if (suites.length === 0) {
    throw new Error(`No E2E suites were configured in ${CONFIG_PATH}`);
  }
  return {
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    suites,
  };
}

function normalizeQuarantineEntry(entry, harness) {
  if (typeof entry === "string") {
    return { path: entry, reason: "" };
  }
  if (entry && typeof entry === "object" && typeof entry.path === "string") {
    return {
      path: entry.path,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    };
  }
  throw new Error(`Invalid ${harness} quarantine entry in ${CONFIG_PATH}: ${JSON.stringify(entry)}`);
}

function discoverSuiteFiles(directory, suffix) {
  const suiteDirectoryPath = path.join(ROOT_DIR, directory);
  return fs.readdirSync(suiteDirectoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.posix.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function getE2ESuiteManifest() {
  const config = readSuiteConfig();
  const suites = config.suites.map((suite) => {
    if (!suite || typeof suite !== "object") {
      throw new Error(`Invalid E2E suite entry in ${CONFIG_PATH}: ${JSON.stringify(suite)}`);
    }
    const harness = typeof suite.harness === "string" ? suite.harness : "";
    const directory = typeof suite.directory === "string" ? suite.directory : "";
    const suffix = typeof suite.suffix === "string" ? suite.suffix : "";
    if (!harness || !directory || !suffix) {
      throw new Error(`E2E suite entries in ${CONFIG_PATH} require harness, directory, and suffix fields.`);
    }

    const discovered = discoverSuiteFiles(directory, suffix);
    const quarantineEntries = Array.isArray(suite.quarantined)
      ? suite.quarantined.map((entry) => normalizeQuarantineEntry(entry, harness))
      : [];
    const quarantinePaths = new Set(quarantineEntries.map((entry) => entry.path));

    for (const entry of quarantineEntries) {
      if (!discovered.includes(entry.path)) {
        throw new Error(`${harness} E2E quarantine entry does not match a discovered spec: ${entry.path}`);
      }
    }

    return {
      harness,
      directory,
      suffix,
      supportedRunner: typeof suite.supportedRunner === "string" ? suite.supportedRunner : "podman",
      discovered,
      quarantined: quarantineEntries,
      included: discovered.filter((file) => !quarantinePaths.has(file)),
    };
  });

  return {
    notes: config.notes,
    suites,
  };
}

export function getE2EHarnessManifest(harness) {
  const manifest = getE2ESuiteManifest();
  const suite = manifest.suites.find((entry) => entry.harness === harness);
  if (!suite) {
    const supported = manifest.suites.map((entry) => entry.harness).join(", ");
    throw new Error(`Unknown E2E harness \`${harness}\`. Supported harnesses: ${supported}`);
  }
  return suite;
}

function parseArgs(argv) {
  const args = [...argv];
  let harness = null;
  let json = false;
  let listHarnesses = false;

  while (args.length > 0) {
    const current = args[0];
    if (current === "--json") {
      json = true;
      args.shift();
      continue;
    }
    if (current === "--list-harnesses") {
      listHarnesses = true;
      args.shift();
      continue;
    }
    if (current === "--harness") {
      args.shift();
      harness = args.shift() ?? null;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return { harness, json, listHarnesses };
}

function printShellList() {
  const { harness } = parseArgs(process.argv.slice(2));
  const manifest = getE2ESuiteManifest();
  const suites = harness ? [getE2EHarnessManifest(harness)] : manifest.suites;
  const included = suites.flatMap((suite) => suite.included);
  process.stdout.write(`${included.join("\n")}\n`);
}

function printJson() {
  const { harness } = parseArgs(process.argv.slice(2));
  const manifest = getE2ESuiteManifest();
  const value = harness
    ? { notes: manifest.notes, suites: [getE2EHarnessManifest(harness)] }
    : manifest;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHarnesses() {
  const manifest = getE2ESuiteManifest();
  process.stdout.write(`${manifest.suites.map((suite) => suite.harness).join("\n")}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.listHarnesses) {
    printHarnesses();
  } else if (args.json) {
    printJson();
  } else {
    printShellList();
  }
}
