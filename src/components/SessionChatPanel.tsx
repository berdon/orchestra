import { memo, useEffect, useMemo, useState, type FormEvent, type RefObject, type UIEvent } from "react";

import { AutocompleteTextarea } from "./AutocompleteTextarea";
import { TranscriptEventCard } from "./TranscriptEventCard";
import { buildProjectMentionLookup, searchProjectReferenceAutocompleteCandidates, type ProjectMentionLink } from "../lib/referenceMentions";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { AgentSummary, PiSetupState, RoleSummary, SessionActivityState, SessionEvent, SessionModelState, SessionRecord, SessionScrollState, SessionStats, SessionStatus, TaskSummary } from "../types";

function formatControlOperationLabel(session: SessionRecord) {
  const operation = session.controlOperation;
  if (!operation) {
    return null;
  }
  const subject = operation.kind === "compact"
    ? (operation.trigger === "auto" ? "Auto-compacting" : "Compacting")
    : "Reloading";
  if (operation.status === "running") {
    return `${subject}…`;
  }
  if (operation.status === "failed") {
    return operation.kind === "compact" ? "Compaction failed" : "Reload failed";
  }
  if (operation.kind === "compact") {
    return operation.trigger === "auto" ? "Auto-compacted" : "Compacted";
  }
  return "Reloaded";
}

function getControlOperationTone(session: SessionRecord) {
  const operation = session.controlOperation;
  if (!operation) {
    return null;
  }
  if (operation.status === "running") {
    return "accent";
  }
  return operation.status === "failed" ? "error" : "success";
}

function formatActivityLabel(activityState?: SessionActivityState, activeToolName?: string | null) {
  switch (activityState) {
    case "thinking":
      return "Thinking";
    case "tool_running":
      return activeToolName ? `Running ${activeToolName}` : "Running tool";
    case "streaming":
      return "Streaming";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function getActivityTone(activityState?: SessionActivityState) {
  switch (activityState) {
    case "streaming":
      return "success";
    case "tool_running":
    case "thinking":
      return "accent";
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

function formatSessionStatusLabel(status: SessionStatus) {
  const label = status.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatCompactNumber(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function formatContextPercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return "Context unknown";
  }
  return `${Math.max(0, Math.round(value))}% context`;
}

function formatCost(value: number | null | undefined) {
  if (value == null || Number.isNaN(value) || value <= 0) {
    return "$0.00";
  }
  return value < 0.01 ? `<$${value.toFixed(2)}` : `$${value.toFixed(2)}`;
}

function resolveMentionAction(
  reference: ProjectMentionLink | null | undefined,
  actions: {
    onOpenTask: (taskId: string) => void;
    onOpenAgent: (agentId: string) => void;
    onOpenRole: (roleId: string) => void;
  },
) {
  if (!reference) {
    return null;
  }

  if (reference.kind === "task" && reference.taskId) {
    return {
      key: `task:${reference.taskId}`,
      label: reference.label,
      onClick: () => actions.onOpenTask(reference.taskId as string),
    };
  }

  if (reference.kind === "agent" && reference.agentId) {
    return {
      key: `agent:${reference.agentId}`,
      label: reference.label,
      onClick: () => actions.onOpenAgent(reference.agentId as string),
    };
  }

  if (reference.kind === "role" && reference.roleId) {
    return {
      key: `role:${reference.roleId}`,
      label: reference.label,
      onClick: () => actions.onOpenRole(reference.roleId as string),
    };
  }

  return null;
}

interface SessionChatPanelProps {
  session: SessionRecord | null;
  title?: string | null;
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  displayedEvents: SessionEvent[];
  sessionPending: boolean;
  sessionDisplayStatus: SessionStatus;
  selectedModelState?: SessionModelState;
  selectedSessionStats?: SessionStats;
  sessionReadOnly?: boolean;
  sessionMessageable?: boolean;
  loadingStatsSessionId?: string | null;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  piSetupState?: PiSetupState | null;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
  onScrollLockChange: (lockedToBottom: boolean) => void;
  formatDateTime: (timestamp: string) => string;
  formatTimestamp: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  getStatusTone: (status: SessionStatus) => string;
  getEventTone: (kind: SessionEvent["kind"]) => string;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
  onOpenTask: (taskId: string, projectId?: string | null) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onCreateNewSession?: () => void;
  onCompactSession?: () => void;
  onOpenPiSettings?: () => void;
  onReloadSession?: () => void;
  emptyStateEyebrow?: string;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateLoading?: boolean;
  surface?: "default" | "page-mobile-detail";
}

interface SessionComposerProps {
  session: SessionRecord;
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  sessionPending: boolean;
  selectedModelState?: SessionModelState;
  sessionReadOnly: boolean;
  sessionMessageable: boolean;
  loadingModelSessionId: string | null;
  changingModelSessionId: string | null;
  draftMessage: string;
  piSetupState?: PiSetupState | null;
  formatDateTime: (timestamp: string) => string;
  formatModelOptionLabel: (state: SessionModelState | undefined) => string;
  onModelChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onSendMessage: () => void;
  onStopSession: () => void;
  onCreateNewSession?: () => void;
  onOpenPiSettings?: () => void;
  onCompactSession?: () => void;
  onReloadSession?: () => void;
}

interface SessionTranscriptProps {
  sessionId: string;
  displayedEvents: SessionEvent[];
  mentionResolver?: (mention: string) => { key: string; label?: string; onClick: () => void } | null;
  transcriptRef: RefObject<HTMLDivElement | null>;
  scrollState: SessionScrollState;
  onScrollLockChange: (lockedToBottom: boolean) => void;
  formatTimestamp: (timestamp: string) => string;
  getEventTone: (kind: SessionEvent["kind"]) => string;
}

function SessionStatsStrip({
  stats,
  loading,
}: {
  stats?: SessionStats;
  loading: boolean;
}) {
  if (!stats && !loading) {
    return null;
  }

  const contextPercent = stats?.contextUsage?.percent ?? null;
  const progressWidth = contextPercent == null ? 0 : Math.min(100, Math.max(0, contextPercent));
  const contextTone = contextPercent != null && contextPercent >= 85
    ? "warning"
    : contextPercent != null && contextPercent >= 60
      ? "accent"
      : "neutral";

  return (
    <section className="session-stats-strip" data-role="session-context-stats">
      <div className="session-stats-strip__header">
        <span className={`status-badge status-badge--${contextTone}`} data-role="session-context-percent">
          {loading && !stats ? "Loading context…" : formatContextPercent(contextPercent)}
        </span>
        <div className="session-stats-strip__progress" aria-hidden="true">
          <div className="session-stats-strip__progress-fill" style={{ width: `${progressWidth}%` }} />
        </div>
      </div>
      <div className="session-stats-strip__metrics muted-copy">
        <span data-role="session-context-window">
          Window {formatCompactNumber(stats?.contextUsage?.tokens)} / {formatCompactNumber(stats?.contextUsage?.contextWindow)} tokens
        </span>
        <span data-role="session-total-token-usage">Used {formatCompactNumber(stats?.tokens.total)} tokens total</span>
        <span data-role="session-message-count">{formatCompactNumber(stats?.totalMessages)} messages</span>
        <span data-role="session-cost">Cost {formatCost(stats?.cost)}</span>
      </div>
    </section>
  );
}

const SessionComposer = memo(function SessionComposer({
  session,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  sessionPending,
  selectedModelState,
  sessionReadOnly,
  sessionMessageable,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  piSetupState,
  formatDateTime,
  formatModelOptionLabel,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
  onCreateNewSession,
  onOpenPiSettings,
  onCompactSession,
  onReloadSession,
}: SessionComposerProps) {
  const [showSessionActions, setShowSessionActions] = useState(false);
  const sessionControlBusy = session.controlOperation?.status === "running";
  const composerDisabled = sessionReadOnly || !sessionMessageable;
  const sessionActionsDisabled = sessionReadOnly || sessionPending || sessionControlBusy;
  const canCreateNewSession = Boolean(onCreateNewSession) && !sessionReadOnly;
  const canCompactSession = Boolean(onCompactSession)
    && !sessionActionsDisabled
    && session.controlCapabilities?.compact.status !== "unsupported";
  const canReloadSession = Boolean(onReloadSession)
    && !sessionActionsDisabled
    && session.controlCapabilities?.reload.status !== "unsupported";

  useEffect(() => {
    setShowSessionActions(false);
  }, [session.id, sessionPending, sessionReadOnly, sessionMessageable]);

  function handleComposerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSendMessage();
  }

  return (
    <>
      {sessionReadOnly ? (
        <div className="session-readonly-banner" data-role="session-terminal-readonly">
          This session is currently attached to an embedded terminal window. Close that window to resume chat here.
        </div>
      ) : null}

      {!sessionReadOnly && !sessionMessageable ? (
        <div className="session-readonly-banner" data-role="session-messageability-closed">
          This session is historical and no longer accepts new messages.
        </div>
      ) : null}

      {piSetupState?.status && piSetupState.status !== "ready" ? (
        <div className="session-readonly-banner" data-role="session-pi-setup-required">
          <div>
            <strong>Pi setup required.</strong> {piSetupState.issues[0]?.message ?? piSetupState.warnings[0]?.message ?? "Connect a provider in Settings → Harness before using Pi-backed sessions."}
          </div>
          {onOpenPiSettings ? (
            <button className="secondary-button" type="button" onClick={onOpenPiSettings}>
              Open Settings → Harness
            </button>
          ) : null}
        </div>
      ) : null}

      <form className="composer" onSubmit={handleComposerSubmit}>
        <div className="field-group field-group--composer">
          <AutocompleteTextarea
            ariaLabel="Message"
            dataRole="composer-input"
            disabled={composerDisabled}
            listDataRole="composer-mention-list"
            onChange={onDraftChange}
            onSubmitShortcut={onSendMessage}
            optionDataRole="composer-mention-option"
            placeholder="Tell the session what to do next…"
            rows={4}
            sources={[
              {
                trigger: "@",
                search: async (query) => searchProjectReferenceAutocompleteCandidates(query, {
                  tasks: referenceTasks,
                  agents: referenceAgents,
                  roles: referenceRoles,
                }, 12),
              },
            ]}
            value={draftMessage}
          />
        </div>
        <div className="composer__footer">
          <div className="composer__meta">
            <p className="muted-copy">
              {sessionReadOnly
                ? "This session is read-only while the embedded terminal window is attached."
                : !sessionMessageable
                  ? "This session is read-only because it is closed history."
                  : sessionPending
                    ? "Response in progress…"
                    : "Press Ctrl+Enter or ⌘+Enter to send."}
            </p>
            <div className="session-detail__meta session-detail__meta--footer">
              <span>Created {formatDateTime(session.createdAt)}</span>
              <span>Updated {formatDateTime(session.updatedAt)}</span>
            </div>
          </div>
          <div className="composer__actions">
            {onCreateNewSession || onCompactSession || onReloadSession ? (
              <div className="session-actions-menu">
                <button
                  className="secondary-button session-actions-menu__trigger"
                  data-role="session-actions-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={showSessionActions}
                  onClick={() => setShowSessionActions((current) => !current)}
                >
                  ⚙
                </button>
                {showSessionActions ? (
                  <div className="session-actions-menu__dropdown" data-role="session-actions-menu" role="menu">
                    {onCreateNewSession ? (
                      <button
                        className="secondary-button session-actions-menu__item"
                        data-role="session-action-new"
                        type="button"
                        role="menuitem"
                        disabled={!canCreateNewSession}
                        onClick={() => {
                          setShowSessionActions(false);
                          if (!canCreateNewSession) {
                            return;
                          }
                          onCreateNewSession();
                        }}
                      >
                        New session
                      </button>
                    ) : null}
                    {onCompactSession ? (
                      <button
                        className="secondary-button session-actions-menu__item"
                        data-role="session-action-compact"
                        type="button"
                        role="menuitem"
                        title={session.controlCapabilities?.compact.reason ?? undefined}
                        disabled={!canCompactSession}
                        onClick={() => {
                          setShowSessionActions(false);
                          if (!canCompactSession) {
                            return;
                          }
                          onCompactSession();
                        }}
                      >
                        Compact
                      </button>
                    ) : null}
                    {onReloadSession ? (
                      <button
                        className="secondary-button session-actions-menu__item"
                        data-role="session-action-reload"
                        type="button"
                        role="menuitem"
                        title={session.controlCapabilities?.reload.reason ?? undefined}
                        disabled={!canReloadSession}
                        onClick={() => {
                          setShowSessionActions(false);
                          if (!canReloadSession) {
                            return;
                          }
                          onReloadSession();
                        }}
                      >
                        Reload
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="session-model-field session-model-field--composer">
              <select
                className="select-input"
                aria-label="Session model"
                value={selectedModelState?.currentModel ? `${selectedModelState.currentModel.provider}/${selectedModelState.currentModel.id}` : ""}
                disabled={
                  composerDisabled ||
                  loadingModelSessionId === session.id ||
                  changingModelSessionId === session.id ||
                  sessionPending ||
                  piSetupState?.status !== "ready"
                }
                onChange={(event) => onModelChange(event.target.value)}
              >
                {!selectedModelState?.availableModels.length || !selectedModelState.currentModel ? (
                  <option value="">{formatModelOptionLabel(selectedModelState)}</option>
                ) : null}
                {selectedModelState?.availableModels.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.name} · {model.provider}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="secondary-button"
              data-role="stop-session-runtime"
              type="button"
              disabled={composerDisabled || !sessionPending}
              onClick={onStopSession}
            >
              Stop
            </button>
            <button
              className="primary-button"
              data-role="send-message"
              type="submit"
              aria-label="Send message"
              title="Send message"
            >
              ↗
            </button>
          </div>
        </div>
      </form>
    </>
  );
});

const SessionTranscript = memo(function SessionTranscript({
  sessionId,
  displayedEvents,
  mentionResolver,
  transcriptRef,
  scrollState,
  onScrollLockChange,
  formatTimestamp,
  getEventTone,
}: SessionTranscriptProps) {
  const [wrapTranscript, setWrapTranscript] = useState(true);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
  }, [displayedEvents, sessionId, transcriptRef, wrapTranscript]);

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    const nextLockedState = distanceFromBottom <= 24;

    if (nextLockedState !== scrollState.lockedToBottom) {
      onScrollLockChange(nextLockedState);
    }
  }

  const getTooltipProps = useExplanatoryTooltipProps();

  function handleAutoScrollToggle() {
    const nextLockedState = !scrollState.lockedToBottom;
    const node = transcriptRef.current;

    if (nextLockedState && node) {
      node.scrollTop = node.scrollHeight;
    }

    onScrollLockChange(nextLockedState);
  }

  return (
    <div className="session-transcript-wrap">
      <div className="session-transcript-controls">
        <button
          type="button"
          className="transcript-wrap-toggle"
          data-role="session-scroll-lock-toggle"
          data-auto-scroll-mode={scrollState.lockedToBottom ? "on" : "off"}
          aria-pressed={scrollState.lockedToBottom}
          aria-label={scrollState.lockedToBottom ? "Disable auto-scroll" : "Enable auto-scroll and jump to latest"}
          {...getTooltipProps(
            scrollState.lockedToBottom
              ? "Follow the live transcript and keep the latest output in view."
              : "Pause transcript following so you can inspect earlier output.",
          )}
          onClick={handleAutoScrollToggle}
        >
          <span aria-hidden="true">{scrollState.lockedToBottom ? "↓" : "⏸"}</span>
          <span>{scrollState.lockedToBottom ? "Auto-scroll on" : "Auto-scroll off"}</span>
        </button>
        <button
          type="button"
          className="transcript-wrap-toggle"
          data-role="session-wrap-toggle"
          data-wrap-mode={wrapTranscript ? "wrap" : "nowrap"}
          aria-pressed={wrapTranscript}
          aria-label={wrapTranscript ? "Disable transcript line wrapping" : "Enable transcript line wrapping"}
          {...getTooltipProps(
            wrapTranscript
              ? "Wrap long transcript lines so they stay inside the panel."
              : "Show each transcript line without wrapping.",
          )}
          onClick={() => setWrapTranscript((current) => !current)}
        >
          <span aria-hidden="true">{wrapTranscript ? "↩" : "↔"}</span>
          <span>{wrapTranscript ? "Wrap" : "No wrap"}</span>
        </button>
      </div>
      <div
        className={wrapTranscript ? "session-transcript session-transcript--wrapped" : "session-transcript session-transcript--nowrap"}
        data-role="session-transcript"
        data-scroll-locked={scrollState.lockedToBottom ? "true" : "false"}
        data-wrap-mode={wrapTranscript ? "wrap" : "nowrap"}
        ref={transcriptRef}
        role="log"
        aria-live="polite"
        onScroll={handleTranscriptScroll}
      >
        {displayedEvents.map((event) => (
          <TranscriptEventCard
            key={event.id}
            event={event}
            formatTimestamp={formatTimestamp}
            tone={getEventTone(event.kind)}
            mentionLinkDataRole="transcript-mention-link"
            mentionResolver={mentionResolver}
          />
        ))}
      </div>
    </div>
  );
});

export function SessionChatPanel({
  session,
  title,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  displayedEvents,
  sessionPending,
  sessionDisplayStatus,
  selectedModelState,
  selectedSessionStats,
  sessionReadOnly = false,
  sessionMessageable = true,
  loadingStatsSessionId,
  loadingModelSessionId,
  changingModelSessionId,
  draftMessage,
  piSetupState,
  transcriptRef,
  scrollState,
  onScrollLockChange,
  formatDateTime,
  formatTimestamp,
  formatModelOptionLabel,
  getStatusTone,
  getEventTone,
  onModelChange,
  onDraftChange,
  onSendMessage,
  onStopSession,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
  onCreateNewSession,
  onCompactSession,
  onOpenPiSettings,
  onReloadSession,
  emptyStateEyebrow = "No session selected",
  emptyStateTitle = "Create or select a session",
  emptyStateDescription = "Use the session list to select an existing session or create a new one to begin the interaction flow.",
  emptyStateLoading = false,
  surface = "default",
}: SessionChatPanelProps) {
  const projectMentionLookup = useMemo(
    () => buildProjectMentionLookup({ tasks: referenceTasks, agents: referenceAgents, roles: referenceRoles }),
    [referenceAgents, referenceRoles, referenceTasks],
  );

  const mentionResolver = useMemo(
    () => (mention: string) => resolveMentionAction(projectMentionLookup.get(mention.trim().toLowerCase()), {
      onOpenTask,
      onOpenAgent,
      onOpenRole,
    }),
    [onOpenAgent, onOpenRole, onOpenTask, projectMentionLookup],
  );
  const getTooltipProps = useExplanatoryTooltipProps();
  const activeTaskId = session?.activeTaskId ?? null;
  const activeTaskProjectId = session?.activeTaskProjectId ?? session?.taskProjectId ?? null;

  return (
    <section
      className={[
        "panel",
        "session-detail-panel",
        "session-chat-panel",
        sessionReadOnly || !sessionMessageable ? "session-chat-panel--readonly" : null,
        session ? "session-chat-panel--desktop-native-resize" : null,
      ].filter(Boolean).join(" ")}
      data-role="session-chat-panel"
      data-session-id={session?.id ?? ""}
      data-terminal-attached={sessionReadOnly ? "true" : "false"}
      data-messageable={sessionMessageable ? "true" : "false"}
      data-surface={surface}
    >
      {session ? (
        <>
          <div className="panel__header panel__header--session-detail">
            <h3 data-role="selected-session-title">{title ?? session.title}</h3>

            <div className="action-cluster action-cluster--session-tools">
              {activeTaskId ? (
                <button
                  className="secondary-button"
                  data-role="session-open-task"
                  type="button"
                  {...getTooltipProps("Open the active task without leaving this session.")}
                  onClick={() => onOpenTask(activeTaskId, activeTaskProjectId)}
                >
                  Open task
                </button>
              ) : null}
              <span className={`status-badge status-badge--${getStatusTone(sessionDisplayStatus)}`}>
                {formatSessionStatusLabel(sessionDisplayStatus)}
              </span>
              <span className={`status-badge status-badge--${getActivityTone(session.activityState)}`}>
                {formatActivityLabel(session.activityState, session.activeToolName)}
              </span>
              {formatControlOperationLabel(session) ? (
                <span className={`status-badge status-badge--${getControlOperationTone(session) ?? "neutral"}`}>
                  {formatControlOperationLabel(session)}
                </span>
              ) : null}
              {sessionReadOnly ? <span className="status-badge status-badge--warning">Terminal attached</span> : null}
              {!sessionReadOnly && !sessionMessageable ? <span className="status-badge status-badge--warning">Read only</span> : null}
            </div>
          </div>

          <SessionStatsStrip
            stats={selectedSessionStats}
            loading={loadingStatsSessionId === session.id || !selectedSessionStats}
          />

          <SessionTranscript
            sessionId={session.id}
            displayedEvents={displayedEvents}
            mentionResolver={mentionResolver}
            transcriptRef={transcriptRef}
            scrollState={scrollState}
            onScrollLockChange={onScrollLockChange}
            formatTimestamp={formatTimestamp}
            getEventTone={getEventTone}
          />

          <SessionComposer
            session={session}
            referenceTasks={referenceTasks}
            referenceAgents={referenceAgents}
            referenceRoles={referenceRoles}
            sessionPending={sessionPending}
            selectedModelState={selectedModelState}
            sessionReadOnly={sessionReadOnly}
            sessionMessageable={sessionMessageable}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={draftMessage}
            piSetupState={piSetupState}
            formatDateTime={formatDateTime}
            formatModelOptionLabel={formatModelOptionLabel}
            onModelChange={onModelChange}
            onDraftChange={onDraftChange}
            onSendMessage={onSendMessage}
            onStopSession={onStopSession}
            onCreateNewSession={onCreateNewSession}
            onOpenPiSettings={onOpenPiSettings}
            onCompactSession={onCompactSession}
            onReloadSession={onReloadSession}
          />
        </>
      ) : (
        <div
          className={emptyStateLoading ? "empty-state empty-state--loading" : "empty-state"}
          data-role={emptyStateLoading ? "session-chat-loading-state" : undefined}
          aria-busy={emptyStateLoading ? "true" : undefined}
        >
          {emptyStateLoading ? (
            <div className="empty-state__loading-visual" aria-hidden="true">
              <span className="empty-state__loading-pill" />
              <span className="empty-state__loading-line empty-state__loading-line--title" />
              <span className="empty-state__loading-line" />
              <span className="empty-state__loading-line empty-state__loading-line--short" />
            </div>
          ) : null}
          <p className="eyebrow">{emptyStateEyebrow}</p>
          <h3>{emptyStateTitle}</h3>
          <p>{emptyStateDescription}</p>
        </div>
      )}
    </section>
  );
}
