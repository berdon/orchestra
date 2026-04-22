#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const packageDir = args["package-dir"];
const providerId = args["provider-id"];

if (!packageDir || !providerId) {
  emit({ type: "error", message: "Missing required --package-dir or --provider-id argument." });
  process.exit(2);
}

const authStorageModule = await import(
  pathToFileURL(path.join(packageDir, "dist", "core", "auth-storage.js")).href
);

const { AuthStorage } = authStorageModule;
const authStorage = AuthStorage.create();
const abortController = new AbortController();
const stdin = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let pendingInput = null;

function clearPendingInput(error) {
  if (!pendingInput) {
    return;
  }
  const { reject } = pendingInput;
  pendingInput = null;
  if (error) {
    reject(error);
  }
}

function waitForInput(kind) {
  return new Promise((resolve, reject) => {
    pendingInput = { kind, resolve, reject };
  });
}

stdin.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "cancel") {
    abortController.abort();
    clearPendingInput(new Error("Login cancelled"));
    return;
  }

  if (message.type === "input" && pendingInput) {
    const { resolve } = pendingInput;
    pendingInput = null;
    resolve(typeof message.value === "string" ? message.value : "");
  }
});

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    abortController.abort();
    clearPendingInput(new Error("Login cancelled"));
  });
}

try {
  await authStorage.login(providerId, {
    onAuth(info) {
      emit({
        type: "auth",
        url: info.url,
        instructions: typeof info.instructions === "string" ? info.instructions : null,
      });
    },
    onPrompt(prompt) {
      emit({
        type: "prompt",
        kind: "prompt",
        message: prompt.message,
        placeholder: typeof prompt.placeholder === "string" ? prompt.placeholder : null,
        allowEmpty: Boolean(prompt.allowEmpty),
      });
      return waitForInput("prompt");
    },
    onProgress(message) {
      emit({ type: "progress", message });
    },
    onManualCodeInput() {
      emit({
        type: "prompt",
        kind: "manual_code",
        message: "Paste the authorization code or full redirect URL.",
        placeholder: null,
        allowEmpty: false,
      });
      return waitForInput("manual_code");
    },
    signal: abortController.signal,
  });

  emit({ type: "success" });
  stdin.close();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit({ type: message === "Login cancelled" ? "cancelled" : "error", message });
  stdin.close();
  process.exit(message === "Login cancelled" ? 130 : 1);
}
