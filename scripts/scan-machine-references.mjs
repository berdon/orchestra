#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_RULES_PATH = join(ROOT_DIR, "guardrails", "machine-reference-rules.json");
const DEFAULT_LOCAL_RULES_PATH = join(ROOT_DIR, "guardrails", "machine-reference-rules.local.json");
const DEFAULT_ALLOWLIST_PATH = join(ROOT_DIR, "guardrails", "machine-reference-allowlist.json");
const DEFAULT_REPORT_DIR = join(ROOT_DIR, ".tmp", "guardrails");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathForMatch(value) {
  return value.replace(/\\/g, "/");
}

export function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += ".";
      continue;
    }
    pattern += escapeRegex(char);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function parseSeedUsernames(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseSeedUsernames(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeRulesConfig(baseConfig, overrideConfig) {
  if (!overrideConfig) {
    return { ...baseConfig };
  }

  return {
    ...baseConfig,
    ...overrideConfig,
    seedUsernames: [
      ...(Array.isArray(baseConfig.seedUsernames) ? baseConfig.seedUsernames : []),
      ...(Array.isArray(overrideConfig.seedUsernames) ? overrideConfig.seedUsernames : []),
    ],
    rules: [
      ...(Array.isArray(baseConfig.rules) ? baseConfig.rules : []),
      ...(Array.isArray(overrideConfig.rules) ? overrideConfig.rules : []),
    ],
  };
}

function compileAllowlistEntry(entry) {
  return {
    ...entry,
    pathRegex: entry.pathGlob ? globToRegExp(entry.pathGlob) : null,
    matchRegex: entry.matchRegex ? new RegExp(entry.matchRegex, entry.matchRegexFlags ?? "") : null,
  };
}

export function loadMatcherConfig({
  rulesPath = DEFAULT_RULES_PATH,
  localRulesPath = DEFAULT_LOCAL_RULES_PATH,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
  extraSeedUsernames = [],
} = {}) {
  const baseRulesConfig = JSON.parse(readFileSync(rulesPath, "utf8"));
  const localRulesConfig = localRulesPath && existsSync(localRulesPath)
    ? JSON.parse(readFileSync(localRulesPath, "utf8"))
    : null;
  const rulesConfig = mergeRulesConfig(baseRulesConfig, localRulesConfig);
  const allowlistConfig = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const usernames = uniqueStrings([
    ...parseSeedUsernames(rulesConfig.seedUsernames ?? []),
    ...parseSeedUsernames(extraSeedUsernames),
  ]);
  const compiledRules = [];

  for (const rule of rulesConfig.rules ?? []) {
    if (rule.kind === "username") {
      if (usernames.length === 0) {
        continue;
      }
      compiledRules.push({
        id: rule.id,
        description: rule.description,
        regex: new RegExp(`\\b(?:${usernames.map((value) => escapeRegex(value)).join("|")})\\b`, "gi"),
      });
      continue;
    }

    if (rule.kind === "regex") {
      compiledRules.push({
        id: rule.id,
        description: rule.description,
        regex: new RegExp(rule.pattern, rule.flags ?? "g"),
      });
    }
  }

  return {
    rulesPath,
    localRulesPath: localRulesConfig ? localRulesPath : null,
    allowlistPath,
    rulesConfig,
    seedUsernames: usernames,
    allowlistEntries: (allowlistConfig.entries ?? []).map(compileAllowlistEntry),
    compiledRules,
  };
}

export function isProbablyText(buffer) {
  if (buffer.length === 0) {
    return true;
  }

  for (const byte of buffer.subarray(0, Math.min(buffer.length, 8192))) {
    if (byte === 0) {
      return false;
    }
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("utf8");
  const replacementCount = (sample.match(/\uFFFD/g) ?? []).length;
  return replacementCount <= Math.max(1, Math.floor(sample.length * 0.02));
}

function buildLineOffsets(content) {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function indexToLineColumn(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: index - offsets[lineIndex] + 1,
  };
}

function shouldSkipMatch(ruleId, matchText) {
  if (ruleId === "unix-home-path" && matchText.includes("/.orchestra/")) {
    return true;
  }
  if (ruleId === "windows-home-path" && matchText.includes(".orchestra")) {
    return true;
  }
  return false;
}

function findAllowlistEntry(finding, allowlistEntries) {
  return allowlistEntries.find((entry) => {
    if (entry.pathRegex && !entry.pathRegex.test(finding.relativePath)) {
      return false;
    }
    if (entry.ruleIds && !entry.ruleIds.includes(finding.ruleId)) {
      return false;
    }
    if (entry.matchContains && !finding.match.includes(entry.matchContains)) {
      return false;
    }
    if (entry.matchRegex && !entry.matchRegex.test(finding.match)) {
      return false;
    }
    return true;
  });
}

export function scanTextContent(content, relativePath, matcherConfig) {
  const offsets = buildLineOffsets(content);
  const findings = [];
  const suppressed = [];
  const dedupe = new Set();

  for (const rule of matcherConfig.compiledRules) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(content)) !== null) {
      const matchText = match[0];
      if (!matchText || shouldSkipMatch(rule.id, matchText)) {
        if (matchText === "") {
          rule.regex.lastIndex += 1;
        }
        continue;
      }

      const key = `${relativePath}:${match.index}:${match.index + matchText.length}:${matchText}`;
      if (dedupe.has(key)) {
        continue;
      }
      dedupe.add(key);

      const { line, column } = indexToLineColumn(offsets, match.index);
      const finding = {
        ruleId: rule.id,
        description: rule.description,
        relativePath,
        line,
        column,
        match: matchText,
      };
      const allowlistEntry = findAllowlistEntry(finding, matcherConfig.allowlistEntries);
      if (allowlistEntry) {
        suppressed.push({ ...finding, reason: allowlistEntry.reason });
        continue;
      }
      findings.push(finding);
    }
  }

  return { findings, suppressed };
}

function collectFilesFromDirectory(directoryPath, output) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const childPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectFilesFromDirectory(childPath, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(childPath);
    }
  }
}

function collectSourceFiles(rootDir) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((filePath) => join(rootDir, filePath));
}

function collectExplicitPaths(rootDir, targets) {
  const files = [];
  for (const target of targets) {
    const absoluteTarget = resolve(target);
    if (!existsSync(absoluteTarget)) {
      throw new Error(`Target does not exist: ${target}`);
    }
    const targetStat = statSync(absoluteTarget);
    if (targetStat.isDirectory()) {
      collectFilesFromDirectory(absoluteTarget, files);
      continue;
    }
    if (targetStat.isFile()) {
      files.push(absoluteTarget);
    }
  }
  return files;
}

export function scanFiles({
  rootDir = ROOT_DIR,
  mode = "source",
  targets = [],
  matcherConfig = loadMatcherConfig(),
} = {}) {
  const absoluteRoot = resolve(rootDir);
  const filePaths = mode === "source"
    ? collectSourceFiles(absoluteRoot)
    : collectExplicitPaths(absoluteRoot, targets);

  const findings = [];
  const suppressed = [];
  const scannedFiles = [];

  for (const filePath of filePaths) {
    const buffer = readFileSync(filePath);
    if (!isProbablyText(buffer)) {
      continue;
    }

    const relativePath = normalizePathForMatch(relative(absoluteRoot, filePath));
    const content = buffer.toString("utf8");
    const result = scanTextContent(content, relativePath, matcherConfig);
    scannedFiles.push(relativePath);
    findings.push(...result.findings);
    suppressed.push(...result.suppressed);
  }

  return {
    scannedFileCount: scannedFiles.length,
    scannedFiles,
    findings,
    suppressed,
  };
}

function formatFinding(finding) {
  return `${finding.relativePath}:${finding.line}:${finding.column} [${finding.ruleId}] ${finding.match}`;
}

function writeReport(reportName, result) {
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  const reportPath = join(DEFAULT_REPORT_DIR, `${reportName}.json`);
  writeFileSync(reportPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    reportName,
    scannedFileCount: result.scannedFileCount,
    findingCount: result.findings.length,
    suppressedCount: result.suppressed.length,
    findings: result.findings,
    suppressed: result.suppressed,
  }, null, 2)}\n`);
  return reportPath;
}

function parseArgs(argv) {
  const parsed = {
    mode: "source",
    rootDir: ROOT_DIR,
    targets: [],
    reportName: "machine-references-source",
    rulesPath: DEFAULT_RULES_PATH,
    localRulesPath: DEFAULT_LOCAL_RULES_PATH,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
    extraSeedUsernames: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--mode":
        parsed.mode = argv[index + 1] ?? parsed.mode;
        index += 1;
        break;
      case "--report-name":
        parsed.reportName = argv[index + 1] ?? parsed.reportName;
        index += 1;
        break;
      case "--root-dir":
        parsed.rootDir = resolve(argv[index + 1] ?? parsed.rootDir);
        index += 1;
        break;
      case "--rules":
        parsed.rulesPath = resolve(argv[index + 1] ?? parsed.rulesPath);
        index += 1;
        break;
      case "--allowlist":
        parsed.allowlistPath = resolve(argv[index + 1] ?? parsed.allowlistPath);
        index += 1;
        break;
      case "--local-rules":
        parsed.localRulesPath = resolve(argv[index + 1] ?? parsed.localRulesPath);
        index += 1;
        break;
      case "--extra-seed-usernames":
        parsed.extraSeedUsernames.push(...parseSeedUsernames(argv[index + 1] ?? ""));
        index += 1;
        break;
      default:
        parsed.targets.push(argument);
        break;
    }
  }

  if (parsed.mode === "paths" && parsed.targets.length === 0) {
    throw new Error("--mode paths requires at least one file or directory target");
  }

  if (parsed.mode === "source") {
    parsed.reportName = parsed.reportName === "machine-references-source"
      ? "machine-references-source"
      : parsed.reportName;
  }

  return parsed;
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const matcherConfig = loadMatcherConfig({
      rulesPath: args.rulesPath,
      localRulesPath: args.localRulesPath,
      allowlistPath: args.allowlistPath,
      extraSeedUsernames: [
        ...args.extraSeedUsernames,
        ...parseSeedUsernames(process.env.ORCHESTRA_MACHINE_REFERENCE_SEED_USERNAMES ?? ""),
      ],
    });
    const result = scanFiles({
      rootDir: args.rootDir,
      mode: args.mode,
      targets: args.targets,
      matcherConfig,
    });
    const reportPath = writeReport(args.reportName, result);

    if (result.findings.length > 0) {
      console.error(`[guardrails] machine-reference scan found ${result.findings.length} issue(s). Report: ${reportPath}`);
      for (const finding of result.findings) {
        console.error(`  - ${formatFinding(finding)}`);
      }
      return 1;
    }

    console.log(`[guardrails] machine-reference scan passed across ${result.scannedFileCount} text file(s). Report: ${reportPath}`);
    if (result.suppressed.length > 0) {
      console.log(`[guardrails] suppressed ${result.suppressed.length} allowlisted match(es).`);
    }
    return 0;
  } catch (error) {
    console.error(`[guardrails] machine-reference scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
