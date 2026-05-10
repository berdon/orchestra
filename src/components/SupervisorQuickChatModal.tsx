import { useEffect, useMemo, useRef } from "react";

import { AutocompleteTextarea } from "./AutocompleteTextarea";
import { SessionSendControls } from "./SessionSendControls";
import { TranscriptEventCard } from "./TranscriptEventCard";
import { buildProjectMentionLookup, searchProjectReferenceAutocompleteCandidates, searchProjectTagAutocompleteCandidates, type ProjectMentionLink } from "../lib/referenceMentions";
import type { AgentSummary, ProjectSummary, RoleSummary, SessionEvent, SessionRecord, SessionSendMode, TaskSummary } from "../types";

function resolveMentionAction(
  reference: ProjectMentionLink | null | undefined,
  actions: {
    onOpenProject: (projectId: string) => void;
    onOpenTask: (taskId: string) => void;
    onOpenAgent: (agentId: string) => void;
    onOpenRole: (roleId: string) => void;
  },
) {
  if (!reference) {
    return null;
  }

  if (reference.kind === "project" && reference.projectId) {
    return {
      key: `project:${reference.projectId}`,
      label: reference.label,
      onClick: () => actions.onOpenProject(reference.projectId as string),
    };
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

interface SupervisorQuickChatModalProps {
  open: boolean;
  session: SessionRecord | null;
  events: SessionEvent[];
  draftMessage: string;
  pending: boolean;
  error: string | null;
  projects: ProjectSummary[];
  referenceTasks: TaskSummary[];
  referenceAgents: AgentSummary[];
  referenceRoles: RoleSummary[];
  formatTimestamp: (timestamp: string) => string;
  onDraftChange: (value: string) => void;
  onSend: (mode?: SessionSendMode) => void;
  onClose: () => void;
  onOpenFullSession: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
}

export function SupervisorQuickChatModal({
  open,
  session,
  events,
  draftMessage,
  pending,
  error,
  projects,
  referenceTasks,
  referenceAgents,
  referenceRoles,
  formatTimestamp,
  onDraftChange,
  onSend,
  onClose,
  onOpenFullSession,
  onOpenProject,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
}: SupervisorQuickChatModalProps) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionBusy = pending
    || session?.activityState === "thinking"
    || session?.activityState === "tool_running"
    || session?.activityState === "streaming";
  const projectMentionLookup = useMemo(
    () => buildProjectMentionLookup({ projects, tasks: referenceTasks, agents: referenceAgents, roles: referenceRoles }),
    [projects, referenceAgents, referenceRoles, referenceTasks],
  );
  const mentionResolver = useMemo(
    () => (mention: string) => resolveMentionAction(projectMentionLookup.get(mention.trim().toLowerCase()), {
      onOpenProject,
      onOpenTask,
      onOpenAgent,
      onOpenRole,
    }),
    [onOpenAgent, onOpenProject, onOpenRole, onOpenTask, projectMentionLookup],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, session?.id]);

  useEffect(() => {
    if (!open || !transcriptRef.current) {
      return;
    }

    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [events, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="quick-chat-overlay" data-role="supervisor-quick-chat-overlay" onClick={onClose}>
      <section className="quick-chat-modal panel" data-role="supervisor-quick-chat" onClick={(event) => event.stopPropagation()}>
        <div className="quick-chat-modal__header-block">
          <div className="panel__header panel__header--session-detail">
            <div>
              <p className="eyebrow">Supervisor quick chat</p>
              <h3>{session?.title ?? "Loading supervisor session…"}</h3>
              <p className="muted-copy">Persistent floating operator chat. Close and reopen without losing context.</p>
            </div>
            <div className="action-cluster">
              <button className="secondary-button" type="button" onClick={onOpenFullSession}>
                Open in Sessions
              </button>
              <button className="secondary-button" type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>

          {error ? <p className="error-copy">{error}</p> : null}
        </div>

        <div className="quick-chat-transcript session-transcript session-transcript--wrapped" data-role="supervisor-transcript" ref={transcriptRef} role="log" aria-live="polite">
          {events.map((event) => (
            <TranscriptEventCard
              key={event.id}
              event={event}
              formatTimestamp={formatTimestamp}
              mentionLinkDataRole="transcript-mention-link"
              mentionResolver={mentionResolver}
              tone={event.kind}
            />
          ))}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <label className="field-group field-group--composer">
            <span className="field-group__label">Message supervisor</span>
            <AutocompleteTextarea
              dataRole="supervisor-composer-input"
              listDataRole="supervisor-mention-list"
              onChange={onDraftChange}
              onEscape={onClose}
              onSubmitShortcut={onSend}
              optionDataRole="supervisor-mention-option"
              placeholder="Ask the supervisor to coordinate, review, or help steer the project…"
              rows={4}
              sources={[
                {
                  trigger: "@",
                  search: async (query) => searchProjectReferenceAutocompleteCandidates(query, {
                    projects,
                    tasks: referenceTasks,
                    agents: referenceAgents,
                    roles: referenceRoles,
                  }, 12),
                },
                {
                  trigger: "#",
                  allowEmptyQuery: true,
                  search: async (query) => searchProjectTagAutocompleteCandidates(query, referenceTasks, [], 12),
                },
              ]}
              textareaRef={inputRef}
              value={draftMessage}
            />
          </label>
          <div className="composer__footer">
            <p className="muted-copy">Press Ctrl+Enter or ⌘+Enter to send. Ctrl+T reopens this chat any time.</p>
            <SessionSendControls
              busy={sessionBusy}
              disabled={!session}
              onSendWithMode={onSend}
              sendButtonDataRole="supervisor-send-message"
              optionsTriggerDataRole="supervisor-send-options-trigger"
              optionsMenuDataRole="supervisor-send-options-menu"
              queueOptionDataRole="supervisor-send-mode-queue"
              interruptOptionDataRole="supervisor-send-mode-interrupt"
              sendButtonLabel="Send message to supervisor with the default behavior"
            />
          </div>
        </form>
      </section>
    </div>
  );
}
