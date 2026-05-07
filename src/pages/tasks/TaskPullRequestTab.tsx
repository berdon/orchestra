import { useCallback, useEffect, useMemo, useState } from "react";

import { useOrchestraClient } from "../../lib/orchestraClient";
import { buildTaskCommentThreads } from "../../lib/taskCommentThreads";
import { TaskDiffViewer } from "../../components/TaskDiffViewer";
import { TaskCommentMessage } from "../../components/TaskCommentMessage";
import type {
  AgentSummary,
  RoleSummary,
  TaskCommentInput,
  TaskDetail,
  TaskFileReference,
  TaskPullRequestDetail,
  TaskPullRequestFile,
  TaskSummary,
} from "../../types";

interface TaskPullRequestTabProps {
  task: TaskDetail;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  commentAuthor: string;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
}

function selectedFileKey(file: TaskPullRequestFile) {
  return `${file.repositoryId}:${file.oldPath ?? ""}:${file.newPath ?? ""}:${file.displayPath}`;
}

function repoCommentPathSet(repository: TaskPullRequestDetail["repositories"][number]) {
  return new Set(
    repository.files.flatMap((file) => [file.displayPath, file.oldPath ?? "", file.newPath ?? ""].filter(Boolean)),
  );
}

export function TaskPullRequestTab({
  task,
  tasks,
  agents,
  roles,
  commentAuthor,
  onAddComment,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
}: TaskPullRequestTabProps) {
  const orchestraClient = useOrchestraClient();
  const [detail, setDetail] = useState<TaskPullRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const loadPullRequest = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);
    try {
      const next = await orchestraClient.tasks.getPullRequest(task.id);
      setDetail(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load PR details.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orchestraClient, task.id]);

  useEffect(() => {
    void loadPullRequest();
  }, [loadPullRequest]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadPullRequest(true);
    }, 30_000);
    const handleFocus = () => {
      void loadPullRequest(true);
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadPullRequest]);

  const repositories = detail?.repositories ?? [];
  const changedRepositories = repositories.filter((repository) => repository.status === "changed");
  const cleanRepositories = repositories.filter((repository) => repository.status === "clean");
  const unavailableRepositories = repositories.filter((repository) => repository.status === "unavailable");
  const changedFiles = changedRepositories.flatMap((repository) => repository.files);

  useEffect(() => {
    if (!changedFiles.length) {
      setSelectedKey(null);
      return;
    }
    const nextSelected = changedFiles.find((file) => selectedFileKey(file) === selectedKey) ?? changedFiles[0];
    setSelectedKey(selectedFileKey(nextSelected));
  }, [changedFiles, selectedKey]);

  const selectedFile = changedFiles.find((file) => selectedFileKey(file) === selectedKey) ?? null;
  const prComments = useMemo(
    () => task.comments.filter((comment) => comment.diffAnchor?.kind === "task_pr"),
    [task.comments],
  );
  const commentThreads = useMemo(() => buildTaskCommentThreads(prComments), [prComments]);

  const summary = useMemo(() => ({
    changedRepositoryCount: changedRepositories.length,
    changedFileCount: changedFiles.length,
    committedFileCount: repositories.reduce((total, repository) => total + repository.committedFileCount, 0),
    uncommittedFileCount: repositories.reduce((total, repository) => total + repository.uncommittedFileCount, 0),
    mixedFileCount: repositories.reduce((total, repository) => total + repository.mixedFileCount, 0),
  }), [changedFiles.length, changedRepositories.length, repositories]);

  return (
    <section className="task-section" data-role="task-detail-tabpanel-pr">
      <div className="task-section__header">
        <div>
          <p className="eyebrow">PR</p>
          <h4>Cross-repo review</h4>
          <p className="supporting-copy">This live review tab compares each task-associated repository against the best available merge-base between the task worktree HEAD and the repository default-branch refs, then overlays current workspace edits on top. If no shared base can be found, the repo falls back to a worktree-only review instead of failing the whole tab.</p>
        </div>
        <button className="secondary-button" data-role="task-pr-refresh" type="button" onClick={() => void loadPullRequest(true)}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="task-section-list" data-role="task-pr-summary">
        <article className="task-history-card">
          <div className="workflow-section__header">
            <strong>Summary</strong>
            <span className="status-badge status-badge--neutral">{summary.changedFileCount} files</span>
          </div>
          <div className="workforce-meta-grid muted-copy">
            <span>{summary.changedRepositoryCount} changed repos</span>
            <span>{summary.committedFileCount} committed</span>
            <span>{summary.uncommittedFileCount} uncommitted</span>
            <span>{summary.mixedFileCount} mixed</span>
          </div>
        </article>
      </div>

      {loading ? <p className="muted-copy">Loading PR details…</p> : null}
      {error ? <p className="error-copy">{error}</p> : null}
      {!loading && !error && repositories.length === 0 ? <p className="supporting-copy">No repositories are linked to this task.</p> : null}

      {!loading && !error ? (
        <div className="task-section-list" data-role="task-pr-repositories">
          {[...changedRepositories, ...cleanRepositories, ...unavailableRepositories].map((repository) => {
            const currentPaths = repoCommentPathSet(repository);
            const repoOutdatedThreads = commentThreads.filter((thread) => {
              const diffAnchor = thread.comment.diffAnchor;
              if (diffAnchor?.repositoryId !== repository.repositoryId) {
                return false;
              }
              return ![diffAnchor.oldPath, diffAnchor.newPath, thread.comment.relativePath]
                .filter(Boolean)
                .some((path) => currentPaths.has(path as string));
            });
            return (
              <article className="task-history-card" data-role="task-pr-repository-card" key={repository.repositoryId}>
                <div className="workflow-section__header">
                  <div>
                    <strong>{repository.repositoryName}</strong>
                    <p className="muted-copy">{repository.repositorySlug}</p>
                  </div>
                  <div className="action-cluster action-cluster--wrap">
                    <span className={`status-badge status-badge--${repository.status === "changed" ? "accent" : repository.status === "clean" ? "success" : "warning"}`}>{repository.status}</span>
                    {repository.worktreeOnly ? <span className="status-badge status-badge--warning">worktree-only</span> : null}
                  </div>
                </div>
                <div className="workforce-meta-grid muted-copy">
                  <span>Review root: {repository.reviewRootPath ?? "Unavailable"}</span>
                  <span>Source: {repository.reviewRootKind ?? "Unavailable"}</span>
                  <span>Base: {repository.baseCommitHash ?? "Unavailable"}</span>
                  <span>HEAD: {repository.headCommitHash ?? "Unavailable"}</span>
                </div>
                {repository.unavailableReason ? <p className="error-copy">{repository.unavailableReason}</p> : null}
                {repository.status === "clean" ? <p className="supporting-copy">No changes are currently associated with this repo for the PR view.</p> : null}
                {repository.files.length ? (
                  <div className="task-section-list" data-role="task-pr-files">
                    {repository.files.map((file) => {
                      const key = selectedFileKey(file);
                      const active = key === selectedKey;
                      return (
                        <button
                          className="secondary-button task-relane-menu__option"
                          data-role="task-pr-file-button"
                          data-active={active ? "true" : "false"}
                          key={key}
                          type="button"
                          onClick={() => setSelectedKey(key)}
                        >
                          <strong>{file.displayPath}</strong>
                          <span className="muted-copy">{file.changeType} · {file.origin} · +{file.additions} / -{file.deletions}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {repoOutdatedThreads.length ? (
                  <div className="task-section-list" data-role="task-pr-repo-outdated-comments">
                    <p className="eyebrow">Outdated repo comments</p>
                    {repoOutdatedThreads.map((thread) => (
                      <article className="transcript-event transcript-event--system task-comment-thread__parent" key={thread.comment.id}>
                        <div className="transcript-event__meta">
                          <span>{thread.comment.author}</span>
                          <div className="transcript-event__meta-group">
                            <span className="status-badge status-badge--warning">Outdated</span>
                            <time dateTime={thread.comment.updatedAt}>{new Date(thread.comment.updatedAt).toLocaleString()}</time>
                          </div>
                        </div>
                        <TaskCommentMessage
                          dataRole="task-pr-comment-message-link"
                          fileReferences={task.fileReferences}
                          tasks={tasks}
                          agents={agents}
                          roles={roles}
                          message={thread.comment.message}
                          onOpenFileReference={onOpenFileReference}
                          onOpenTask={onOpenTask}
                          onOpenAgent={onOpenAgent}
                          onOpenRole={onOpenRole}
                        />
                      </article>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}

      {selectedFile ? (
        <TaskDiffViewer
          taskId={task.id}
          tasks={tasks}
          agents={agents}
          roles={roles}
          file={selectedFile}
          fileReferences={task.fileReferences}
          comments={prComments}
          commentAuthor={commentAuthor}
          onAddComment={async (draft) => {
            const success = await onAddComment(draft);
            if (success) {
              await loadPullRequest(true);
            }
            return success;
          }}
          onOpenFileReference={onOpenFileReference}
          onOpenTask={onOpenTask}
          onOpenAgent={onOpenAgent}
          onOpenRole={onOpenRole}
        />
      ) : !loading && !error ? (
        <p className="supporting-copy" data-role="task-pr-empty-state">No diffable changes are currently available across the task repositories.</p>
      ) : null}

      <p className="muted-copy" data-role="task-pr-generated-at">Generated {detail ? new Date(detail.generatedAt).toLocaleString() : "just now"}.</p>
    </section>
  );
}
