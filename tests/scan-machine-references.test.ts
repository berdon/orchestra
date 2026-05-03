import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMatcherConfig, scanTextContent } from "../scripts/scan-machine-references.mjs";

const matcherConfig = loadMatcherConfig();
const artifactMatcherConfig = loadMatcherConfig({
  allowlistPath: join(process.cwd(), "guardrails", "artifact-machine-reference-allowlist.json"),
});

describe("machine-reference guardrail scanner", () => {
  it("flags concrete macOS Orchestra paths", () => {
    const result = scanTextContent(
      'workspace = "/Users/alice/.orchestra/projects/demo/task-workspaces/tasks/task-1"\n',
      "fixtures/bad-path.txt",
      matcherConfig,
    );

    expect(result.findings.map((finding) => finding.ruleId)).toContain("unix-orchestra-machine-path");
    expect(result.findings.map((finding) => finding.match)).toContain(
      "/Users/alice/.orchestra/projects/demo/task-workspaces/tasks/task-1",
    );
  });

  it("flags concrete Windows home-directory paths", () => {
    const result = scanTextContent(
      String.raw`cwd = "C:\\Users\\alice\\.orchestra\\projects\\demo\\sessions"\n`,
      "fixtures/windows-path.txt",
      matcherConfig,
    );

    expect(result.findings.map((finding) => finding.ruleId)).toContain("windows-orchestra-machine-path");
  });

  it("does not flag ~/.orchestra placeholders", () => {
    const result = scanTextContent(
      'sessionDir = "~/.orchestra/projects/orchestra/sessions"\n',
      "fixtures/placeholder.txt",
      matcherConfig,
    );

    expect(result.findings).toEqual([]);
  });

  it("merges optional local rules with runtime seed usernames", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "machine-reference-rules-"));

    try {
      const rulesPath = join(tempDir, "machine-reference-rules.json");
      const localRulesPath = join(tempDir, "machine-reference-rules.local.json");
      const allowlistPath = join(tempDir, "machine-reference-allowlist.json");
      writeFileSync(rulesPath, `${JSON.stringify({
        seedUsernames: [],
        rules: [
          {
            id: "configured-username",
            kind: "username",
            description: "Configured machine-specific usernames or handles.",
          },
        ],
      }, null, 2)}\n`);
      writeFileSync(localRulesPath, `${JSON.stringify({
        seedUsernames: ["local-user"],
      }, null, 2)}\n`);
      writeFileSync(allowlistPath, `${JSON.stringify({ entries: [] }, null, 2)}\n`);

      const runtimeMatcherConfig = loadMatcherConfig({
        rulesPath,
        localRulesPath,
        allowlistPath,
        extraSeedUsernames: ["cli-user", "env-user"],
      });
      const result = scanTextContent(
        'local-user cli-user env-user\n',
        "fixtures/usernames.txt",
        runtimeMatcherConfig,
      );

      expect(result.findings.map((finding) => finding.match).sort()).toEqual([
        "cli-user",
        "env-user",
        "local-user",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses allowlisted placeholders that intentionally exercise home-path logic", () => {
    const result = scanTextContent(
      'expect(getProjectSlugFromCwd("/home/example-user/workspace/orchestra")).toBe("orchestra");\n',
      "tests/orchestra-paths.test.ts",
      matcherConfig,
    );

    expect(result.findings).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.reason).toMatch(/project slug/i);
  });

  it("suppresses documented third-party runtime path findings in bundled runtime payloads", () => {
    const result = scanTextContent(
      'upstream build path: /Users/runner/work/_temp/webkit-release\n',
      "src-tauri/target/release/bundle/macos/Orchestra.app/Contents/Resources/pi-runtime/bun/bin/bun.strings.txt",
      artifactMatcherConfig,
    );

    expect(result.findings).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.reason).toMatch(/third-party/i);
  });

  it("keeps first-party app-bundle path leaks release-blocking", () => {
    const result = scanTextContent(
      'cwd = "/Users/alice/workspace/orchestra"\n',
      "src-tauri/target/release/bundle/macos/Orchestra.app/Contents/MacOS/orc.strings.txt",
      artifactMatcherConfig,
    );

    expect(result.findings.map((finding) => finding.ruleId)).toContain("unix-home-path");
    expect(result.suppressed).toEqual([]);
  });
});
