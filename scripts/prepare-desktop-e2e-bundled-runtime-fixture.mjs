#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outputRoot = process.argv[2];
if (!outputRoot) {
  console.error("Usage: prepare-desktop-e2e-bundled-runtime-fixture.mjs <output-root>");
  process.exit(1);
}

const root = path.resolve(outputRoot);
const executableRelativePath = "bin/pi";
const bundledBunRelativePath = "bun/bin/bun";
const packageDirRelativePath = "package";
const executablePath = path.join(root, executableRelativePath);
const bundledBunPath = path.join(root, bundledBunRelativePath);
const packageDir = path.join(root, packageDirRelativePath);
const packageJsonPath = path.join(packageDir, "package.json");
const manifestPath = path.join(root, "manifest.json");
const expectedBunDir = path.dirname(bundledBunPath);
const expectedPackageDir = packageDir;
const bundledBunOutput = "desktop e2e bundled bun ok";

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.dirname(executablePath), { recursive: true });
fs.mkdirSync(path.dirname(bundledBunPath), { recursive: true });
fs.mkdirSync(packageDir, { recursive: true });

const bundledBunScript = `#!/usr/bin/env bash
set -euo pipefail
echo ${JSON.stringify(bundledBunOutput)}
`;
fs.writeFileSync(bundledBunPath, bundledBunScript, "utf8");
fs.chmodSync(bundledBunPath, 0o755);

const piScript = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const expectedPackageDir = ${JSON.stringify(expectedPackageDir)};
const expectedBunDir = ${JSON.stringify(expectedBunDir)};
const expectedBunOutput = ${JSON.stringify(bundledBunOutput)};
const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);

if (process.env.PI_PACKAGE_DIR !== expectedPackageDir) {
  console.error(
    "expected PI_PACKAGE_DIR " + expectedPackageDir + ", got " + (process.env.PI_PACKAGE_DIR || "<missing>"),
  );
  process.exit(21);
}

if (!pathEntries.includes(expectedBunDir)) {
  console.error(
    "expected PATH to include bundled bun dir " + expectedBunDir + ", got " + (process.env.PATH || "<missing>"),
  );
  process.exit(22);
}

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : null;

const MODELS = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "anthropic",
    reasoning: true,
  },
];

function readSessionEntries() {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return [];
  }
  return fs
    .readFileSync(sessionFile, "utf8")
    .split("\\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getCurrentModel() {
  const entries = readSessionEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "model_change") {
      return MODELS.find((model) => model.provider === entry.provider && model.id === entry.modelId) || MODELS[0];
    }
  }
  return MODELS[0];
}

function ensureBundledBunWorks() {
  const result = spawnSync("bun", [], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(
      "bundled bun failed with status "
        + String(result.status)
        + ": "
        + (result.stderr || result.stdout || "<no output>"),
    );
    process.exit(23);
  }
  if (String(result.stdout || "").trim() !== expectedBunOutput) {
    console.error("unexpected bundled bun stdout: " + JSON.stringify(result.stdout || ""));
    process.exit(24);
  }
}

function respond(command, data) {
  process.stdout.write(
    JSON.stringify({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      data,
    }) + "\\n",
  );
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const command = JSON.parse(trimmed);
  if (command.type === "get_available_models") {
    ensureBundledBunWorks();
    respond(command, { models: MODELS });
    return;
  }
  if (command.type === "get_state") {
    respond(command, { model: getCurrentModel(), thinkingLevel: "off" });
    return;
  }
  if (command.type === "get_session_stats") {
    respond(command, {
      sessionFile: sessionFile || null,
      sessionId: "desktop-e2e-bundled-runtime",
      userMessages: 0,
      assistantMessages: 0,
      totalTokens: 0,
      contextWindow: 200000,
      contextTokens: null,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return;
  }
  respond(command, {});
});
`;
fs.writeFileSync(executablePath, piScript, "utf8");
fs.chmodSync(executablePath, 0o755);

fs.writeFileSync(
  packageJsonPath,
  `${JSON.stringify({
    name: "desktop-e2e-bundled-runtime-fixture",
    version: "0.0.0-desktop-e2e",
    private: true,
  }, null, 2)}\n`,
  "utf8",
);

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function manifestPlatform() {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}

function manifestArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return process.arch;
  }
}

const manifest = {
  schemaVersion: 1,
  source: "desktop-e2e-fixture",
  platform: manifestPlatform(),
  arch: manifestArch(),
  packageName: "desktop-e2e-bundled-runtime-fixture",
  packageVersion: "0.0.0-desktop-e2e",
  runtimeVersion: "0.0.0-desktop-e2e",
  orchestraPackVersion: 1,
  executableRelativePath,
  packageDirRelativePath,
  bundledBunRelativePath,
  files: [
    { path: executableRelativePath, sha256: sha256(executablePath), executable: true },
    { path: bundledBunRelativePath, sha256: sha256(bundledBunPath), executable: true },
    { path: `${packageDirRelativePath}/package.json`, sha256: sha256(packageJsonPath), executable: false },
  ],
  builtAt: new Date().toISOString(),
  notes: "Desktop E2E bundled-runtime fixture",
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.error(`[desktop-e2e-bundled-runtime] fixture ready at ${root}`);
