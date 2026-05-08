import { memo, useCallback, useMemo } from "react";

import { MarkdownContent } from "./MarkdownContent";
import { buildProjectMentionLookup, buildTaskFileMentionLookup } from "../lib/referenceMentions";
import { recordInputPerfRender } from "../lib/testInputPerformance";
import type { AgentSummary, RoleSummary, TaskFileReference, TaskSummary } from "../types";

interface TaskCommentMessageProps {
  message: string;
  fileReferences: TaskFileReference[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  dataRole?: string;
}

export const TaskCommentMessage = memo(function TaskCommentMessage({
  message,
  fileReferences,
  tasks,
  agents,
  roles,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
  dataRole,
}: TaskCommentMessageProps) {
  recordInputPerfRender("task-comment-message");
  const projectLookup = useMemo(() => buildProjectMentionLookup({ tasks, agents, roles }), [agents, roles, tasks]);
  const fileLookup = useMemo(() => buildTaskFileMentionLookup(fileReferences), [fileReferences]);
  const mentionResolver = useCallback((mention: string) => {
    const normalizedMention = mention.trim().toLowerCase();
    const projectReference = projectLookup.get(normalizedMention) ?? null;
    if (projectReference?.kind === "task" && projectReference.taskId) {
      return {
        key: `task:${projectReference.taskId}`,
        label: projectReference.label,
        onClick: () => onOpenTask(projectReference.taskId as string),
      };
    }
    if (projectReference?.kind === "agent" && projectReference.agentId) {
      return {
        key: `agent:${projectReference.agentId}`,
        label: projectReference.label,
        onClick: () => onOpenAgent(projectReference.agentId as string),
      };
    }
    if (projectReference?.kind === "role" && projectReference.roleId) {
      return {
        key: `role:${projectReference.roleId}`,
        label: projectReference.label,
        onClick: () => onOpenRole(projectReference.roleId as string),
      };
    }

    const fileReference = fileLookup.get(normalizedMention) ?? null;
    if (!fileReference) {
      return null;
    }

    return {
      key: `file:${fileReference.reference.id}`,
      label: fileReference.label,
      onClick: () => onOpenFileReference(fileReference.reference),
    };
  }, [fileLookup, onOpenAgent, onOpenFileReference, onOpenRole, onOpenTask, projectLookup]);

  return (
    <MarkdownContent
      className="task-comment-message markdown-content"
      dataRole="task-comment-markdown"
      mentionLinkDataRole={dataRole}
      mentionResolver={mentionResolver}
      message={message}
    />
  );
});

TaskCommentMessage.displayName = "TaskCommentMessage";
