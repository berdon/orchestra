import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getCurrentWindowHandle,
  invokeCommand,
  setInputValue,
  waitForText,
  waitForWindowCount,
} from "./driver";
import { createProjectViaSettings, createTaskViaTasks, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

function startHarnessServer() {
  return new Promise<{ server: Server; url: string }>((resolve, reject) => {
    const server = createServer((request, response) => {
      if (!request.url?.startsWith("/")) {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser harness</title>
    <style>
      body { font-family: sans-serif; margin: 24px; }
      main { display: grid; gap: 12px; max-width: 480px; }
      button { padding: 10px 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Browser harness</h1>
      <p id="status">Interactive page ready</p>
      <button id="submit-order" class="cta cta-primary" data-testid="checkout-submit" type="button">Submit order</button>
      <p>Clicks: <span id="click-count">0</span></p>
      <input id="notes" aria-label="Notes" value="Initial notes" />
    </main>
    <script>
      const count = document.getElementById('click-count');
      document.getElementById('submit-order').addEventListener('click', () => {
        const next = Number(count.textContent || '0') + 1;
        count.textContent = String(next);
        document.title = 'Browser harness (' + next + ')';
      });
      setInterval(() => {
        document.getElementById('status').textContent = 'Heartbeat ' + new Date().toISOString();
      }, 250);
    </script>
  </body>
</html>`);
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine browser harness server address."));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe("desktop task browser", () => {
  const servers = new Set<Server>();

  afterEach(() => {
    for (const server of servers) {
      server.close();
    }
    servers.clear();
  });

  it.skipIf(!isDesktopE2E)("opens and navigates the task browser, preserves normal page interaction, and creates a DOM-anchored task comment from inspect selection", async () => {
    const sessionId = await createReadyWebdriverSession();
    const { server, url } = await startHarnessServer();
    servers.add(server);

    try {
      await ensureReactReady(sessionId);
      const mainHandle = await getCurrentWindowHandle(sessionId);

      await createProjectViaSettings(sessionId, "Browser Task Project", "Desktop task browser regression project.");
      await switchProject(sessionId, "Browser Task Project");
      await createTaskViaTasks(sessionId, {
        title: "Task browser coverage",
        description: "Verify the in-app browser window and DOM comment flow.",
      });
      await waitForText(sessionId, "Task browser coverage");
      const projectId = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((project) => project.name === 'Browser Task Project')?.id ?? '');
      expect(projectId).toBeTruthy();
      const taskId = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId })
        .then((tasks) => tasks.find((task) => task.title === 'Task browser coverage')?.id ?? '');
      expect(taskId).toBeTruthy();
      await clickSelector(sessionId, '[data-role="task-detail-tab-browser"]');
      await waitForText(sessionId, "Task browser surface");

      await clickSelector(sessionId, '[data-role="task-browser-open"]');
      await setInputValue(sessionId, '[data-role="task-browser-url"]', url);
      await clickSelector(sessionId, '[data-role="task-browser-navigate"]');

      const handles = await waitForWindowCount(sessionId, 2, 45_000);
      const browserHandle = handles.find((handle) => handle !== mainHandle);
      expect(browserHandle).toBeTruthy();

      await clickSelector(sessionId, '[data-role="task-browser-refresh"]');
      await waitForText(sessionId, url);

      await invokeCommand(sessionId, 'debug_eval_task_browser', {
        taskId,
        script: "document.getElementById('submit-order')?.click();",
      });
      await clickSelector(sessionId, '[data-role="task-browser-refresh"]');
      await waitForText(sessionId, "Browser harness (1)");

      await clickSelector(sessionId, '[data-role="task-browser-inspect-toggle"]');
      await waitForText(sessionId, "Inspecting");
      await invokeCommand(sessionId, 'debug_eval_task_browser', {
        taskId,
        script: `(() => {
          const button = document.getElementById('submit-order');
          if (!(button instanceof HTMLElement)) {
            return;
          }
          const rect = button.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }));
          button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
        })();`,
      });
      await ensureReactReady(sessionId);
      await clickSelector(sessionId, '[data-role="task-browser-refresh"]');
      await waitForText(sessionId, "Browser harness (1)");
      await waitForText(sessionId, "button#submit-order");
      await waitForText(sessionId, "Submit order");
      await setInputValue(sessionId, '[data-role="task-browser-comment-message"]', 'Please increase the spacing around this CTA.');
      await clickSelector(sessionId, '[data-role="task-browser-add-comment"]');
      await waitForText(sessionId, 'Please increase the spacing around this CTA.');

      const comments = await invokeCommand<any[]>(sessionId, 'list_task_comments', {
        taskId,
      });
      const domComment = comments.find((comment) => comment.message === 'Please increase the spacing around this CTA.');
      expect(domComment?.anchor?.kind).toBe('dom');
      expect(domComment?.anchor?.snapshot?.tagName).toBe('button');
      expect(domComment?.anchor?.locator?.testId).toBe('checkout-submit');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
