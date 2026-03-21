import { fetch as undiciFetch } from "undici";

const webdriverUrl = process.env.ORCHESTRA_WEBDRIVER_URL ?? "http://127.0.0.1:4444";
const tauriBinary = process.env.ORCHESTRA_TAURI_BINARY;

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function webdriverRequest(path: string, init?: RequestInit) {
  const response = await undiciFetch(`${webdriverUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  return response.json() as Promise<any>;
}

export async function createWebdriverSession() {
  if (!tauriBinary) {
    throw new Error("ORCHESTRA_TAURI_BINARY is required for desktop E2E runs.");
  }

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
  });

  const sessionId = response?.value?.sessionId ?? response?.sessionId ?? null;
  if (!sessionId) {
    throw new Error(`Unable to create WebDriver session: ${JSON.stringify(response)}`);
  }

  await sleep(1_000);
  return sessionId as string;
}

export async function deleteWebdriverSession(sessionId: string) {
  await undiciFetch(`${webdriverUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
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

export async function clickSelector(sessionId: string, selector: string) {
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

  if (!clicked) {
    throw new Error(`Unable to click selector ${selector}`);
  }
}

export async function clickByText(sessionId: string, selector: string, text: string) {
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

  if (!clicked) {
    throw new Error(`Unable to click text ${text} in ${selector}`);
  }
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

export async function selectByLabel(sessionId: string, selector: string, label: string) {
  const updated = await executeScript<boolean>(
    sessionId,
    `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return false;
      }
      const option = Array.from(element.options).find((entry) => (entry.label || entry.textContent || '').trim() === arguments[1]);
      if (!option) {
        return false;
      }
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    [selector, label],
  );

  if (!updated) {
    throw new Error(`Unable to select label ${label} for ${selector}`);
  }
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

export async function invokeCommand<T>(sessionId: string, command: string, args: Record<string, unknown> = {}) {
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
      args: [command, args],
    }),
  });

  const errorMessage = String(response?.value?.__error ?? response?.value?.message ?? response?.value?.error ?? "");
  if (errorMessage) {
    throw new Error(`Invoke command failed: ${command}: ${JSON.stringify(response)}`);
  }

  return response?.value?.value as T;
}

export async function ensureReactReady(sessionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastDom = "";
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const url = await getCurrentUrl(sessionId);
      const dom = await getDomSnapshot(sessionId);
      lastDom = dom.html;
      if (url === "about:blank" || dom.html.trim() === "<html><head></head><body></body></html>" || dom.html.trim() === "") {
        await navigateTo(sessionId, "http://tauri.localhost");
        await sleep(500);
        continue;
      }

      if (dom.html.includes('<div id="root">') || dom.html.includes('<div id="root"></div>') || dom.text.length > 0) {
        return dom;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(`React app did not become ready: ${lastDom.slice(0, 1000)} ${lastError}`.trim());
}
