import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

function startJsonServer(handler: (body: unknown, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/invoke") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    handler(body, req, res);
  });

  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine test server address"));
        return;
      }
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
    server.on("error", reject);
  });
}

function waitForLine(proc: ChildProcessWithoutNullStreams, predicate: (line: string) => boolean, timeoutMs = 15000) {
  return new Promise<string>((resolvePromise, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for matching rpc output. Buffer: ${buffer}`));
    }, timeoutMs);

    function onData(chunk: Buffer | string) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (predicate(line)) {
          cleanup();
          resolvePromise(line);
          return;
        }
      }
    }

    function onExit(code: number | null) {
      cleanup();
      reject(new Error(`pi rpc process exited before predicate matched (code ${code})`));
    }

    function cleanup() {
      clearTimeout(timeout);
      proc.stdout.off("data", onData);
      proc.off("exit", onExit);
    }

    proc.stdout.on("data", onData);
    proc.on("exit", onExit);
  });
}

describe("orchestra tools extension", () => {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    if (proc) {
      proc.kill("SIGTERM");
      await once(proc, "exit").catch(() => undefined);
      proc = null;
    }
    if (server) {
      await new Promise((resolvePromise) => server!.close(() => resolvePromise(undefined)));
      server = null;
    }
  });

  test("runs orchestra extension commands through rpc mode", { timeout: 15000 }, async () => {
    const requests: unknown[] = [];
    const started = await startJsonServer((body, _req, res) => {
      requests.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: { ok: true, command: (body as any).command } }));
    });
    server = started.server;

    proc = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--extension",
        resolve("extensions/orchestra-tools.ts"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ORCHESTRA_BRIDGE_URL: started.url,
          ORCHESTRA_BRIDGE_TOKEN: "test-token",
          ORCHESTRA_ALLOWED_COMMANDS_JSON: JSON.stringify([
            { name: "list_agents", description: "List Orchestra agents", requiredPermission: "agents.read" },
          ]),
          ORCHESTRA_AUTH_CONTEXT_JSON: JSON.stringify({ actorType: "user", actorId: "tester" }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    proc.stdin.write(`${JSON.stringify({ type: "prompt", message: "/orchestra-run list_agents {}" })}\n`);

    const line = await waitForLine(proc, (entry) => {
      try {
        const parsed = JSON.parse(entry);
        return parsed.type === "extension_ui_request" && parsed.method === "notify";
      } catch {
        return false;
      }
    });

    const payload = JSON.parse(line);
    expect(payload.message).toContain('"ok": true');
    expect(requests).toHaveLength(1);
    expect((requests[0] as any).command).toBe("list_agents");
    expect((requests[0] as any).token).toBe("test-token");
  });

  test("passes task context payloads through the orchestra bridge", { timeout: 15000 }, async () => {
    const requests: unknown[] = [];
    const started = await startJsonServer((body, _req, res) => {
      requests.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: { task: { id: "task-1", title: "Context task" } } }));
    });
    server = started.server;

    proc = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--extension",
        resolve("extensions/orchestra-tools.ts"),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ORCHESTRA_BRIDGE_URL: started.url,
          ORCHESTRA_BRIDGE_TOKEN: "test-token",
          ORCHESTRA_ALLOWED_COMMANDS_JSON: JSON.stringify([
            { name: "get_task_context", description: "Get a task context", requiredPermission: "tasks.read" },
          ]),
          ORCHESTRA_AUTH_CONTEXT_JSON: JSON.stringify({ actorType: "user", actorId: "tester" }),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    proc.stdin.write(
      `${JSON.stringify({ type: "prompt", message: "/orchestra-run get_task_context {\"taskId\":\"task-1\"}" })}\n`,
    );

    const line = await waitForLine(proc, (entry) => {
      try {
        const parsed = JSON.parse(entry);
        return parsed.type === "extension_ui_request" && parsed.method === "notify";
      } catch {
        return false;
      }
    });

    const payload = JSON.parse(line);
    expect(payload.message).toContain("Context task");
    expect((requests[0] as any).command).toBe("get_task_context");
    expect((requests[0] as any).payload.taskId).toBe("task-1");
  });
});
