import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildSessionStorageInfo } from "../src/lib/orchestraPaths";

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

describe("pi SessionManager with Orchestra sessionDir", () => {
  it("creates, lists, resumes, and appends to sessions inside .orchestra", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "orchestra-sessiondir-"));

    try {
      const homeDir = join(sandboxRoot, "home");
      const cwd = join(sandboxRoot, "workspace", "orchestra");
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });

      const storage = buildSessionStorageInfo(homeDir, "orchestra");
      mkdirSync(storage.sessionDir, { recursive: true });

      const sessionManager = SessionManager.create(cwd, storage.sessionDir);
      const sessionFile = sessionManager.getSessionFile();

      expect(sessionFile).toBeTruthy();
      expect(sessionFile?.startsWith(storage.sessionDir)).toBe(true);
      expect(existsSync(sessionFile!)).toBe(false);

      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Create an Orchestra session in the managed directory." }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Session acknowledged." }],
        api: "test",
        provider: "test",
        model: "stub",
        usage: createUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });

      expect(existsSync(sessionFile!)).toBe(true);

      const parsedEntries = parseSessionEntries(readFileSync(sessionFile!, "utf8"));
      expect(parsedEntries[0]).toMatchObject({
        type: "session",
        cwd,
      });
      expect(parsedEntries.filter((entry) => entry.type === "message")).toHaveLength(2);

      const listedSessions = await SessionManager.list(cwd, storage.sessionDir);
      expect(listedSessions).toHaveLength(1);
      expect(listedSessions[0]?.path).toBe(sessionFile);
      expect(listedSessions[0]?.cwd).toBe(cwd);
      expect(listedSessions[0]?.messageCount).toBe(2);

      const resumed = SessionManager.continueRecent(cwd, storage.sessionDir);
      expect(resumed.getSessionFile()).toBe(sessionFile);

      resumed.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Resume the same session instead of creating a new one." }],
        timestamp: Date.now(),
      });

      const resumedEntries = parseSessionEntries(readFileSync(sessionFile!, "utf8"));
      expect(resumedEntries.filter((entry) => entry.type === "message")).toHaveLength(3);
      expect(resumed.getSessionDir()).toBe(storage.sessionDir);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});
