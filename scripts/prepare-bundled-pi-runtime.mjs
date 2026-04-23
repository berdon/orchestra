#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const generatedRoot = path.join(repoRoot, "src-tauri", "gen", "pi-runtime");
const packageName = process.env.ORCHESTRA_PI_PACKAGE_NAME?.trim() || "@mariozechner/pi-coding-agent";
const requestedVersion = process.env.ORCHESTRA_PI_VERSION?.trim() || "latest";
const releaseBaseUrl = process.env.ORCHESTRA_PI_RELEASE_BASE_URL?.trim() || "https://github.com/badlogic/pi-mono/releases/download";
const npmBinary = process.env.ORCHESTRA_NPM_BINARY?.trim() || "npm";
const executableName = process.platform === "win32" ? "pi.exe" : "pi";
const platform = mapPlatform(process.platform);
const arch = mapArch(process.arch);

function mapPlatform(value) {
  switch (value) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return value;
  }
}

function mapArch(value) {
  switch (value) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return value;
  }
}

function assetNameFor(platformName, archName) {
  if (platformName === "windows") {
    if (archName !== "x64") {
      throw new Error(`No published bundled Pi runtime asset is available for windows/${archName}.`);
    }
    return `pi-${platformName}-${archName}.zip`;
  }
  return `pi-${platformName}-${archName}.tar.gz`;
}

function npmView(specifier, field) {
  return execFileSync(npmBinary, ["view", specifier, field, "--silent"], {
    encoding: "utf8",
  }).trim();
}

function replaceBufferOccurrences(buffer, from, to) {
  const fromBuffer = Buffer.from(from, "utf8");
  const toBuffer = Buffer.from(to, "utf8");
  if (fromBuffer.length !== toBuffer.length) {
    throw new Error(`Replacement length mismatch for ${from} -> ${to}`);
  }

  let replaced = 0;
  let searchOffset = 0;
  while (searchOffset < buffer.length) {
    const index = buffer.indexOf(fromBuffer, searchOffset);
    if (index === -1) {
      break;
    }
    toBuffer.copy(buffer, index);
    replaced += 1;
    searchOffset = index + fromBuffer.length;
  }
  return replaced;
}

async function sanitizeBundledPiRuntime(runtimeRoot) {
  const executablePath = path.join(runtimeRoot, executableName);
  const executableBuffer = await readFile(executablePath);
  for (const [from, to] of [
    ["/home/runner/work/pi-mono/pi-mono", "/workspace/pi-build/pi-bundle-src"],
    [
      "/Users/administrator/Library/Services/buildkite-agent/builds/darwin-aarch64-15-1/bun/bun",
      "/workspace/vendor/buildkite/bun-runtime/sanitized-source-root/arm64-darwin/bun/buildsrc-",
    ],
    [
      "/Users/runner/work/_temp/webkit-release",
      "/workspace/vendor/webkit-release-build-",
    ],
  ]) {
    replaceBufferOccurrences(executableBuffer, from, to);
  }
  await writeFile(executablePath, executableBuffer);

  const readmePath = path.join(runtimeRoot, "README.md");
  if (existsSync(readmePath)) {
    const readme = await readFile(readmePath, "utf8");
    const sanitized = readme.replace(
      /See \[openclaw\/openclaw\]\(https:\/\/github\.com\/openclaw\/openclaw\) for a real-world SDK integration\./g,
      "See the Pi documentation for a real-world SDK integration.",
    );
    if (sanitized !== readme) {
      await writeFile(readmePath, sanitized);
    }
  }

  for (const relativePath of ["CHANGELOG.md", "examples"]) {
    await rm(path.join(runtimeRoot, relativePath), { recursive: true, force: true });
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function extractArchive(archivePath, destination) {
  await mkdir(destination, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    runCommand("unzip", ["-q", archivePath, "-d", destination]);
    return;
  }
  runCommand("tar", ["-xzf", archivePath, "-C", destination]);
}

async function main() {
  console.log(`[orchestra] refreshing bundled Pi runtime from ${packageName}@${requestedVersion}`);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "orchestra-bundled-pi-runtime-"));

  try {
    const resolvedVersion = npmView(
      requestedVersion === "latest" ? packageName : `${packageName}@${requestedVersion}`,
      "version",
    );
    const tagName = `v${resolvedVersion}`;
    const assetName = assetNameFor(platform, arch);
    const assetUrl = `${releaseBaseUrl}/${tagName}/${assetName}`;
    const archivePath = path.join(tempRoot, assetName);
    const extractRoot = path.join(tempRoot, "extract");

    await downloadFile(assetUrl, archivePath);
    await extractArchive(archivePath, extractRoot);

    const extractedRuntimeRoot = path.join(extractRoot, "pi");
    if (!existsSync(extractedRuntimeRoot)) {
      throw new Error(`Expected extracted Pi runtime directory is missing: ${extractedRuntimeRoot}`);
    }

    const packageJson = JSON.parse(await readFile(path.join(extractedRuntimeRoot, "package.json"), "utf8"));
    const executablePath = path.join(extractedRuntimeRoot, executableName);
    if (!existsSync(executablePath)) {
      throw new Error(`Bundled Pi runtime executable is missing from extracted archive: ${executablePath}`);
    }
    await chmod(executablePath, 0o755);

    const nextGeneratedRoot = path.join(tempRoot, "generated", "pi-runtime");
    const nextRuntimeRoot = path.join(nextGeneratedRoot, "runtime");
    await mkdir(nextGeneratedRoot, { recursive: true });
    await cp(extractedRuntimeRoot, nextRuntimeRoot, { recursive: true });
    await sanitizeBundledPiRuntime(nextRuntimeRoot);

    const manifest = {
      schemaVersion: 1,
      source: "github-release-standalone",
      platform,
      arch,
      packageName,
      packageVersion: packageJson.version,
      runtimeVersion: packageJson.version,
      orchestraPackVersion: 1,
      requestedVersionSpec: requestedVersion,
      executableRelativePath: `runtime/${executableName}`,
      packageDirRelativePath: "runtime",
      builtAt: new Date().toISOString(),
      sourceTag: tagName,
      sourceAssetName: assetName,
      sourceAssetUrl: assetUrl,
      notes: `Generated from the published standalone Pi runtime release asset ${assetName}. Orchestra refreshes this pack on every packaged build.`,
    };
    await writeFile(path.join(nextGeneratedRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    await rm(generatedRoot, { recursive: true, force: true });
    await mkdir(path.dirname(generatedRoot), { recursive: true });
    await rename(nextGeneratedRoot, generatedRoot);

    console.log(
      `[orchestra] bundled Pi runtime ready: ${packageJson.version} -> ${path.join(generatedRoot, "runtime", executableName)}`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[orchestra] failed to prepare bundled Pi runtime: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
