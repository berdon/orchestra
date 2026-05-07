import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentSummary, RoleSummary, TaskCommentInput, TaskDetail, TaskSummary } from "../types";
import { useOrchestraBootstrap, useOrchestraClient } from "../lib/orchestraClient";
import { formatDomAnchorTarget } from "../lib/taskComments";
import { TaskCommentComposer } from "./TaskCommentComposer";

interface TaskBrowserPanelProps {
  task: TaskDetail;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
}

const TASK_BROWSER_EVENT_NAME = "orchestra:task-browser-change";

function createBrowserCommentDraft(author = "User"): TaskCommentInput {
  return {
    author,
    message: "",
    interruptAgent: false,
  };
}

export function TaskBrowserPanel({
  task,
  tasks,
  agents,
  roles,
  onAddComment,
}: TaskBrowserPanelProps) {
  const orchestraClient = useOrchestraClient();
  const bootstrap = useOrchestraBootstrap();
  const [browserState, setBrowserState] = useState<import("../types").TaskBrowserSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState<TaskCommentInput>(() => createBrowserCommentDraft());

  const supported = bootstrap.capabilities.tasks.browser?.availability === "available";

  const refresh = useCallback(async () => {
    if (!supported) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await orchestraClient.tasks.getBrowserState(task.id);
      setBrowserState(next);
      setUrlDraft(next.currentUrl ?? "");
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load task browser state.");
    } finally {
      setLoading(false);
    }
  }, [orchestraClient.tasks, supported, task.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setCommentDraft((current) => ({ ...createBrowserCommentDraft(current.author), author: current.author }));
  }, [task.id]);

  useEffect(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || event.detail.taskId !== task.id) {
        return;
      }
      void refresh();
    };
    window.addEventListener(TASK_BROWSER_EVENT_NAME, listener);
    return () => window.removeEventListener(TASK_BROWSER_EVENT_NAME, listener);
  }, [refresh, task.id]);

  const selectedAnchor = browserState?.lastSelectedAnchor ?? null;
  const selectedAnchorLabel = useMemo(
    () => (selectedAnchor ? formatDomAnchorTarget(selectedAnchor) : null),
    [selectedAnchor],
  );

  async function runAction(actionId: string, action: () => Promise<import("../types").TaskBrowserSession>) {
    setActionPending(actionId);
    setError(null);
    try {
      const next = await action();
      setBrowserState(next);
      setUrlDraft(next.currentUrl ?? "");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Task browser action failed.");
    } finally {
      setActionPending(null);
    }
  }

  async function handleAddElementComment() {
    if (!selectedAnchor || !commentDraft.message.trim()) {
      return;
    }

    const saved = await onAddComment({
      ...commentDraft,
      anchor: {
        kind: "dom",
        browserSessionId: selectedAnchor.browserSessionId,
        url: selectedAnchor.url,
        pageTitle: selectedAnchor.pageTitle,
        domRevision: selectedAnchor.domRevision,
        locator: selectedAnchor.locator,
        snapshot: selectedAnchor.snapshot,
      },
      selectedText: null,
      repositoryId: null,
      relativePath: null,
      absolutePath: null,
      lineStart: null,
      lineEnd: null,
      columnStart: null,
      columnEnd: null,
    });

    if (saved) {
      setCommentDraft((current) => ({ ...createBrowserCommentDraft(current.author), author: current.author }));
    }
  }

  if (!supported) {
    return (
      <section className="task-browser-panel task-history-card">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Browser</p>
            <h4>Desktop-only task browser</h4>
          </div>
          <span className="status-badge status-badge--neutral">Unavailable</span>
        </div>
        <p className="muted-copy">The task browser surface is only available in the desktop Tauri shell.</p>
      </section>
    );
  }

  return (
    <section className="task-browser-panel task-history-card" data-role="task-browser-panel">
      <div className="workflow-section__header">
        <div>
          <p className="eyebrow">Browser</p>
          <h4>{browserState?.pageTitle?.trim() || "Task browser surface"}</h4>
        </div>
        <div className="transcript-event__meta-group">
          <span className={`status-badge status-badge--${browserState?.inspectMode ? "accent" : "neutral"}`} data-role="task-browser-inspect-state">
            {browserState?.inspectMode ? "Inspecting" : "Interactive"}
          </span>
          <span className="status-badge status-badge--neutral" data-role="task-browser-dom-revision">
            DOM {browserState?.domRevision ?? 0}
          </span>
        </div>
      </div>

      <div className="task-browser-panel__controls">
        <button
          className="secondary-button"
          data-role="task-browser-open"
          disabled={Boolean(actionPending)}
          type="button"
          onClick={() => void runAction("open", () => orchestraClient.tasks.showBrowser(task.id))}
        >
          Open / reveal browser
        </button>
        <button
          className="secondary-button"
          data-role="task-browser-refresh"
          disabled={Boolean(actionPending) || loading}
          type="button"
          onClick={() => void refresh()}
        >
          Refresh state
        </button>
        <button
          className="secondary-button"
          data-role="task-browser-inspect-toggle"
          disabled={Boolean(actionPending)}
          type="button"
          onClick={() => void runAction("inspect", () => orchestraClient.tasks.setBrowserInspectMode(task.id, !browserState?.inspectMode))}
        >
          {browserState?.inspectMode ? "Exit inspect mode" : "Enter inspect mode"}
        </button>
      </div>

      <label className="field-group task-browser-panel__navigate">
        <span className="field-group__label">Navigate browser</span>
        <div className="task-browser-panel__navigate-row">
          <input
            className="text-input"
            data-role="task-browser-url"
            placeholder="https://localhost:3000"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
          />
          <button
            className="primary-button"
            data-role="task-browser-navigate"
            disabled={!urlDraft.trim() || Boolean(actionPending)}
            type="button"
            onClick={() => void runAction("navigate", () => orchestraClient.tasks.navigateBrowser(task.id, urlDraft))}
          >
            Navigate
          </button>
        </div>
      </label>

      <dl className="task-browser-panel__meta">
        <div>
          <dt>URL</dt>
          <dd data-role="task-browser-current-url">{browserState?.currentUrl ?? "about:blank"}</dd>
        </div>
        <div>
          <dt>Ready state</dt>
          <dd>{browserState?.lastReadyState ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Last mutation</dt>
          <dd>{browserState?.lastMutationAt ? new Date(browserState.lastMutationAt).toLocaleString() : "No DOM mutations reported yet."}</dd>
        </div>
      </dl>

      <div className="task-browser-panel__selection">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Selected element</p>
            <h4>{selectedAnchorLabel ?? "No DOM element selected"}</h4>
          </div>
          {selectedAnchor ? <span className="status-badge status-badge--accent">DOM anchor</span> : null}
        </div>
        {selectedAnchor ? (
          <>
            {selectedAnchor.snapshot.textPreview ? (
              <pre className="task-comment-thread__quote">{selectedAnchor.snapshot.textPreview}</pre>
            ) : null}
            <p className="muted-copy">Click an element in inspect mode, then leave a task comment anchored to that DOM selection here.</p>
            <TaskCommentComposer
              author={commentDraft.author}
              authorDataRole="task-browser-comment-author"
              tasks={tasks}
              agents={agents}
              roles={roles}
              interruptChecked={commentDraft.interruptAgent}
              interruptDataRole="task-browser-comment-interrupt"
              message={commentDraft.message}
              messageDataRole="task-browser-comment-message"
              messageLabel="Comment on selected element"
              mentionListDataRole="task-browser-comment-mention-list"
              mentionOptionDataRole="task-browser-comment-mention-option"
              onAuthorChange={(author) => setCommentDraft((current) => ({ ...current, author }))}
              onInterruptChange={(interruptAgent) => setCommentDraft((current) => ({ ...current, interruptAgent }))}
              onMessageChange={(message) => setCommentDraft((current) => ({ ...current, message }))}
              onSubmit={() => void handleAddElementComment()}
              rows={3}
              submitDataRole="task-browser-add-comment"
              submitLabel="Add element comment"
              taskId={task.id}
            />
          </>
        ) : (
          <p className="muted-copy">Open the browser surface, turn on inspect mode, hover to highlight, and click an element to capture a DOM anchor for task comments.</p>
        )}
      </div>

      {error ? <p className="error-copy">{error}</p> : null}
    </section>
  );
}
