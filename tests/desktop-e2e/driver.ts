import { execFile } from "node:child_process";
import { promisify } from "node:util";

const webdriverUrl = process.env.ORCHESTRA_WEBDRIVER_URL ?? "http://127.0.0.1:4444";
const tauriBinary = process.env.ORCHESTRA_TAURI_BINARY;
const previewUrl = process.env.ORCHESTRA_DESKTOP_E2E_PREVIEW_URL ?? "http://127.0.0.1:1420";
const execFileAsync = promisify(execFile);

async function killLingeringDesktopAppProcesses() {
  if (!tauriBinary) {
    return;
  }

  await execFileAsync("bash", ["-lc", `pkill -f ${JSON.stringify(tauriBinary)} || true`], {
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function webdriverRequest(path: string, init?: RequestInit, options?: { retries?: number }) {
  const headers = {
    "content-type": "application/json",
    ...(init?.headers ?? {}),
  } as Record<string, string>;

  let lastError = "";
  const retries = Math.max(1, options?.retries ?? 5);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const args = ["-sS", "--connect-timeout", "10", "--max-time", "60", "-X", init?.method ?? "GET", `${webdriverUrl}${path}`];
    for (const [key, value] of Object.entries(headers)) {
      args.push("-H", `${key}: ${value}`);
    }

    if (typeof init?.body === "string") {
      args.push("--data", init.body);
    }

    try {
      const { stdout } = await execFileAsync("curl", args, {
        maxBuffer: 10 * 1024 * 1024,
      });
      return JSON.parse(stdout || "null");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(500 * (attempt + 1));
    }
  }

  throw new Error(lastError || `Unable to reach webdriver at ${webdriverUrl}${path}`);
}

async function listWebdriverSessions() {
  const response = await webdriverRequest("/sessions", { method: "GET" }).catch(() => null);
  const sessions = Array.isArray(response?.value) ? response.value : [];
  return sessions
    .map((entry: { id?: string; sessionId?: string }) => entry.id ?? entry.sessionId ?? null)
    .filter((value: string | null): value is string => Boolean(value));
}

async function cleanupWebdriverSessions() {
  const sessions = await listWebdriverSessions();
  for (const sessionId of sessions) {
    await deleteWebdriverSession(sessionId).catch(() => undefined);
  }
}

async function setWebdriverTimeouts(sessionId: string, timeouts: { script?: number; pageLoad?: number; implicit?: number }) {
  await webdriverRequest(`/session/${sessionId}/timeouts`, {
    method: "POST",
    body: JSON.stringify(timeouts),
  }, { retries: 1 });
}

export async function createWebdriverSession(timeoutMs = 120_000) {
  if (!tauriBinary) {
    throw new Error("ORCHESTRA_TAURI_BINARY is required for desktop E2E runs.");
  }

  await cleanupWebdriverSessions();

  const deadline = Date.now() + timeoutMs;
  let lastError = "Unable to create WebDriver session before timeout.";

  while (Date.now() < deadline) {
    try {
      const response = await webdriverRequest("/session", {
        method: "POST",
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: {
              browserName: "wry",
              "tauri:options": {
                application: tauriBinary,
              },
            },
          },
        }),
      }, { retries: 1 });

      const sessionId = response?.value?.sessionId ?? response?.sessionId ?? null;
      if (sessionId) {
        await setWebdriverTimeouts(String(sessionId), {
          script: 180_000,
          pageLoad: 180_000,
          implicit: 0,
        }).catch(() => undefined);
        await sleep(5_000);
        return sessionId as string;
      }

      lastError = `Unable to create WebDriver session: ${JSON.stringify(response)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_000);
  }

  throw new Error(lastError);
}

export async function createReadyWebdriverSession(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Unable to create a ready WebDriver session before timeout.";

  while (Date.now() < deadline) {
    let sessionId: string | null = null;
    try {
      sessionId = await createWebdriverSession(120_000);
      await ensureReactReady(sessionId, 60_000);
      await executeScript(sessionId, `
        try {
          window.localStorage?.clear?.();
          window.sessionStorage?.clear?.();
        } catch (_) {}
        window.location.reload();
        return true;
      `);
      await sleep(1_000);
      await ensureReactReady(sessionId, 60_000);
      return sessionId;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (sessionId) {
        await deleteWebdriverSession(sessionId).catch(() => undefined);
      }
      await killLingeringDesktopAppProcesses();
      await sleep(2_000);
    }
  }

  throw new Error(lastError);
}

export async function deleteWebdriverSession(sessionId: string) {
  await webdriverRequest(`/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
}

export async function executeScript<T>(sessionId: string, script: string, args: unknown[] = []) {
  const response = await webdriverRequest(`/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: JSON.stringify({ script, args }),
  });

  const errorMessage = String(response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Script execution failed: ${JSON.stringify(response)}`);
  }

  return response?.value as T;
}

export async function getDomSnapshot(sessionId: string) {
  const value = await executeScript<{ ready?: string; html?: string; text?: string; title?: string }>(
    sessionId,
    `
      return {
        ready: document.readyState,
        html: document.documentElement ? document.documentElement.outerHTML : "",
        text: document.body ? document.body.innerText : "",
        title: document.title,
      };
    `,
  );

  return {
    ready: String(value?.ready ?? ""),
    html: String(value?.html ?? ""),
    text: String(value?.text ?? ""),
    title: String(value?.title ?? ""),
  };
}

export async function getCurrentUrl(sessionId: string) {
  const response = await webdriverRequest(`/session/${sessionId}/url`, {
    method: "GET",
  });
  return String(response?.value ?? "");
}

export async function navigateTo(sessionId: string, url: string) {
  const response = await webdriverRequest(`/session/${sessionId}/url`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });

  const errorMessage = String(response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Unable to navigate to ${url}: ${JSON.stringify(response)}`);
  }
}

export async function waitForSelector(sessionId: string, selector: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown;

  while (Date.now() < deadline) {
    lastState = await executeScript(sessionId, `
      return {
        ready: document.readyState,
        exists: Boolean(document.querySelector(arguments[0])),
        html: document.documentElement ? document.documentElement.outerHTML : "",
        text: document.body ? document.body.innerText : "",
      };
    `, [selector]);

    if ((lastState as { exists?: boolean }).exists) {
      return lastState as { ready: string; exists: boolean; html: string; text: string };
    }

    await sleep(250);
  }

  throw new Error(`Unable to locate selector ${selector}: ${JSON.stringify(lastState)}`);
}

export async function waitForText(sessionId: string, text: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown;

  while (Date.now() < deadline) {
    lastState = await executeScript(sessionId, `
      return {
        ready: document.readyState,
        text: document.body ? document.body.innerText : "",
      };
    `);

    if (String((lastState as { text?: string }).text ?? "").toLowerCase().includes(text.toLowerCase())) {
      return lastState as { ready: string; text: string };
    }

    await sleep(250);
  }

  throw new Error(`Unable to locate text ${text}: ${JSON.stringify(lastState)}`);
}

export async function clickSelector(sessionId: string, selector: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await executeScript<boolean>(
      sessionId,
      `
        const element = document.querySelector(arguments[0]);
        if (!element) {
          return false;
        }
        element.click();
        return true;
      `,
      [selector],
    );

    if (clicked) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`Unable to click selector ${selector}`);
}

export async function waitForEnabledSelector(sessionId: string, selector: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown;

  while (Date.now() < deadline) {
    lastState = await executeScript(sessionId, `
      const element = document.querySelector(arguments[0]);
      if (!(element instanceof HTMLElement)) {
        return { exists: false, disabled: null, text: "" };
      }
      return {
        exists: true,
        disabled: "disabled" in element ? Boolean(element.disabled) : false,
        text: (element.textContent || "").trim(),
      };
    `, [selector]);

    if ((lastState as { exists?: boolean; disabled?: boolean }).exists && !(lastState as { disabled?: boolean }).disabled) {
      return lastState as { exists: boolean; disabled: boolean; text: string };
    }

    await sleep(250);
  }

  throw new Error(`Selector ${selector} did not become enabled: ${JSON.stringify(lastState)}`);
}

export async function clickByText(sessionId: string, selector: string, text: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await executeScript<boolean>(
      sessionId,
      `
        const elements = Array.from(document.querySelectorAll(arguments[0]));
        const match = elements.find((element) => (element.textContent || "").trim().includes(arguments[1]));
        if (!match) {
          return false;
        }
        match.click();
        return true;
      `,
      [selector, text],
    );

    if (clicked) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`Unable to click text ${text} in ${selector}`);
}

export async function clickNthSelector(sessionId: string, selector: string, index: number) {
  const clicked = await executeScript<boolean>(
    sessionId,
    `
      const elements = Array.from(document.querySelectorAll(arguments[0]));
      const match = elements[arguments[1]];
      if (!match) {
        return false;
      }
      match.click();
      return true;
    `,
    [selector, index],
  );

  if (!clicked) {
    throw new Error(`Unable to click ${selector} at index ${index}`);
  }
}

export async function setInputValue(sessionId: string, selector: string, value: string) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return false;
      }
      element.focus();
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      descriptor?.set?.call(element, arguments[1]);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [selector, value],
  );

  if (!updated) {
    throw new Error(`Unable to set value for ${selector}`);
  }
}

export async function setFieldByLabel(sessionId: string, labelText: string, value: string) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find((entry) => {
        const heading = entry.querySelector('.field-group__label');
        return (heading?.textContent || '').trim() === arguments[0];
      });
      const field = label?.querySelector('input, textarea, select');
      if (!field) {
        return false;
      }
      field.focus();
      const prototype = field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : field instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      descriptor?.set?.call(field, arguments[1]);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [labelText, value],
  );

  if (!updated) {
    throw new Error(`Unable to set field with label ${labelText}`);
  }
}

export async function setCheckbox(sessionId: string, selector: string, checked: boolean) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      descriptor?.set?.call(element, Boolean(arguments[1]));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [selector, checked],
  );

  if (!updated) {
    throw new Error(`Unable to set checkbox ${selector}`);
  }
}

export async function getSelectedValue(sessionId: string, selector: string) {
  return executeScript<string>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      return element ? String(element.value || '') : '';
    `,
    [selector],
  );
}

export async function getSelectOptions(sessionId: string, selector: string) {
  return executeScript<Array<{ value: string; label: string }>>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return [];
      }
      return Array.from(element.options).map((entry) => ({
        value: entry.value,
        label: (entry.label || entry.textContent || '').trim(),
      }));
    `,
    [selector],
  );
}

export async function waitForSelectOption(sessionId: string, selector: string, matcher: { value?: string; label?: string }, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastOptions: Array<{ value: string; label: string }> = [];
  while (Date.now() < deadline) {
    lastOptions = await getSelectOptions(sessionId, selector);
    if (lastOptions.some((option) => (matcher.value && option.value === matcher.value) || (matcher.label && option.label === matcher.label))) {
      return lastOptions;
    }
    await sleep(250);
  }
  throw new Error(`Unable to find option in ${selector}: ${JSON.stringify({ matcher, lastOptions })}`);
}

export async function selectValue(sessionId: string, selector: string, value: string) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      descriptor?.set?.call(element, arguments[1]);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [selector, value],
  );

  if (!updated) {
    throw new Error(`Unable to select value ${value} for ${selector}`);
  }
}

export async function selectByLabel(sessionId: string, selector: string, label: string, timeoutMs = 30_000) {
  await waitForSelectOption(sessionId, selector, { label }, timeoutMs);

  const updated = await executeScript<boolean>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!(element instanceof HTMLSelectElement)) {
        return false;
      }
      const option = Array.from(element.options).find((entry) => (entry.label || entry.textContent || '').trim() === arguments[1]);
      if (!option) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      descriptor?.set?.call(element, option.value);
      if (element.getAttribute('data-role') === 'project-switcher') {
        try {
          window.localStorage.setItem('orchestra.mock.active-project-id', option.value);
        } catch (_) {
          // ignore storage write errors in test helpers
        }
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (element.getAttribute('data-role') === 'project-switcher') {
        window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
      }
      return true;
    `,
    [selector, label],
  );

  if (!updated) {
    throw new Error(`Unable to select label ${label} for ${selector}`);
  }
}

export async function waitForSelectedLabel(sessionId: string, selector: string, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastLabel = "";
  while (Date.now() < deadline) {
    lastLabel = await executeScript<string>(
      sessionId,
      `
        const element = document.querySelector(arguments[0]);
        if (!element) {
          return '';
        }
        const option = element.options[element.selectedIndex];
        return (option?.label || option?.textContent || '').trim();
      `,
      [selector],
    );
    if (lastLabel === label) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Expected selected label ${label} for ${selector}, got ${lastLabel}`);
}

export async function selectFieldByLabel(sessionId: string, labelText: string, optionLabel: string) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const labels = Array.from(document.querySelectorAll('label'));
      const label = labels.find((entry) => {
        const heading = entry.querySelector('.field-group__label');
        return (heading?.textContent || '').trim() === arguments[0];
      });
      const field = label?.querySelector('select');
      if (!field) {
        return false;
      }
      const option = Array.from(field.options).find((entry) => (entry.label || entry.textContent || '').trim() === arguments[1]);
      if (!option) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      descriptor?.set?.call(field, option.value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [labelText, optionLabel],
  );

  if (!updated) {
    throw new Error(`Unable to select ${optionLabel} for labeled field ${labelText}`);
  }
}

export async function dispatchWindowEvent(sessionId: string, eventName: string, detail: Record<string, unknown> = {}) {
  await executeScript(
    sessionId,
    `
      window.dispatchEvent(new CustomEvent(arguments[0], { detail: arguments[1] }));
      return true;
    `,
    [eventName, detail],
  );
}

export async function setActiveProject(sessionId: string, projectId: string) {
  await executeScript(
    sessionId,
    `
      window.localStorage.setItem('orchestra.mock.active-project-id', arguments[0]);
      window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
      return true;
    `,
    [projectId],
  );
}

export async function invokeCommandNoWait(sessionId: string, command: string, args: Record<string, unknown> = {}) {
  await executeScript(
    sessionId,
    `
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        throw new Error('Missing Tauri invoke bridge');
      }
      invoke(arguments[0], arguments[1]).catch(() => undefined);
      return true;
    `,
    [command, args],
  );
}

function inferProjectTaskPrefix(name: string) {
  const words = name
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  const initials = words.map((word) => word[0]?.toUpperCase() ?? "").join("");
  if (initials.length >= 2) {
    return initials.slice(0, 6);
  }
  const compact = name.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return (compact.slice(0, 6) || "PRJ").padEnd(Math.min(3, Math.max(3, compact.length || 3)), "P");
}

function withDerivedProjectTaskPrefix(command: string, args: Record<string, unknown>) {
  if (command !== "create_project") {
    return args;
  }
  const input = args.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return args;
  }
  const typedInput = input as { name?: unknown; taskPrefix?: unknown };
  if (typeof typedInput.taskPrefix === "string" && typedInput.taskPrefix.trim().length > 0) {
    return args;
  }
  if (typeof typedInput.name !== "string" || typedInput.name.trim().length === 0) {
    return args;
  }
  return {
    ...args,
    input: {
      ...typedInput,
      taskPrefix: inferProjectTaskPrefix(typedInput.name),
    },
  };
}

export async function invokeCommand<T>(sessionId: string, command: string, args: Record<string, unknown> = {}) {
  const normalizedArgs = withDerivedProjectTaskPrefix(command, args);
  const response = await webdriverRequest(`/session/${sessionId}/execute/async`, {
    method: "POST",
    body: JSON.stringify({
      script: `
        const command = arguments[0];
        const payload = arguments[1];
        const done = arguments[arguments.length - 1];
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) {
          done({ __error: 'Missing Tauri invoke bridge' });
          return;
        }
        invoke(command, payload)
          .then((value) => done({ value }))
          .catch((error) => done({ __error: String(error) }));
      `,
      args: [command, normalizedArgs],
    }),
  });

  const errorMessage = String(response?.value?.__error ?? response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Invoke command failed: ${command}: ${JSON.stringify(response)}`);
  }

  return response?.value?.value as T;
}

export async function getWindowHandles(sessionId: string) {
  const response = await webdriverRequest(`/session/${sessionId}/window/handles`, { method: "GET" });
  return (response?.value ?? []) as string[];
}

export async function getCurrentWindowHandle(sessionId: string) {
  const response = await webdriverRequest(`/session/${sessionId}/window`, { method: "GET" });
  return String(response?.value ?? "");
}

export async function switchToWindow(sessionId: string, handle: string) {
  const response = await webdriverRequest(`/session/${sessionId}/window`, {
    method: "POST",
    body: JSON.stringify({ handle }),
  });
  const errorMessage = String(response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Unable to switch to window ${handle}: ${JSON.stringify(response)}`);
  }
}

export async function closeCurrentWindow(sessionId: string) {
  const response = await webdriverRequest(`/session/${sessionId}/window`, { method: "DELETE" });
  const errorMessage = String(response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Unable to close current window: ${JSON.stringify(response)}`);
  }
  return (response?.value ?? []) as string[];
}

export async function waitForWindowCount(sessionId: string, expectedCount: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastHandles: string[] = [];
  while (Date.now() < deadline) {
    lastHandles = await getWindowHandles(sessionId);
    if (lastHandles.length === expectedCount) {
      return lastHandles;
    }
    await sleep(250);
  }
  throw new Error(`Expected ${expectedCount} windows, got ${lastHandles.length}: ${JSON.stringify(lastHandles)}`);
}

export async function ensureReactReady(sessionId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastDom = "";
  let lastUrl = "";
  let lastError = "";
  let recoveryAttempts = 0;
  while (Date.now() < deadline) {
    try {
      const currentUrl = await getCurrentUrl(sessionId);
      lastUrl = currentUrl;
      const dom = await getDomSnapshot(sessionId);
      lastDom = dom.html;
      const normalizedText = dom.text.toLowerCase();
      const hasAppShell = await executeScript<boolean>(
        sessionId,
        `
          return Boolean(document.querySelector('[data-role="project-switcher"]'))
            || Array.from(document.querySelectorAll('button')).some((entry) => (entry.textContent || '').trim().includes('Settings'));
        `,
      );

      if (hasAppShell) {
        return dom;
      }

      if (
        dom.html.trim() === "<html><head></head><body></body></html>"
        || dom.html.trim() === ""
        || normalizedText.includes("could not connect to localhost")
        || normalizedText.includes("could not connect to tauri.localhost")
        || normalizedText.includes("asset not found")
      ) {
        if (recoveryAttempts === 0) {
          console.error(`[desktop-e2e] waiting for app shell at ${currentUrl}: ${dom.text.trim()}`);
        }
        if (
          recoveryAttempts < 3
          && (
            currentUrl.startsWith('http://localhost')
            || currentUrl.startsWith('http://127.0.0.1')
            || currentUrl.startsWith('http://tauri.localhost')
            || currentUrl.startsWith(previewUrl)
          )
        ) {
          recoveryAttempts += 1;
          try {
            await navigateTo(sessionId, 'tauri://localhost/index.html');
          } catch {}
        }
        await sleep(1000);
        continue;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(`React app did not become ready at ${lastUrl}: ${lastDom.slice(0, 1000)} ${lastError}`.trim());
}
