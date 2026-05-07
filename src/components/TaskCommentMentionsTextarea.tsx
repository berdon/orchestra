import type { MutableRefObject } from "react";

import { AutocompleteTextarea } from "./AutocompleteTextarea";
import { mapTaskFileMentionAutocompleteCandidates, searchProjectReferenceAutocompleteCandidates, searchProjectTagAutocompleteCandidates } from "../lib/referenceMentions";
import { useTaskCommentFileMentions } from "../lib/orchestraData/tasks";
import type { AgentSummary, RoleSummary, TaskSummary } from "../types";

interface TaskCommentMentionsTextareaProps {
  taskId: string;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  value: string;
  currentTaskTags?: string[];
  rows?: number;
  dataRole: string;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  listDataRole: string;
  optionDataRole: string;
  onChange: (value: string) => void;
  onSubmitShortcut?: () => void;
}

export function TaskCommentMentionsTextarea({
  taskId,
  tasks,
  agents,
  roles,
  value,
  currentTaskTags = [],
  rows = 4,
  dataRole,
  textareaRef,
  listDataRole,
  optionDataRole,
  onChange,
  onSubmitShortcut,
}: TaskCommentMentionsTextareaProps) {
  const searchFileMentions = useTaskCommentFileMentions(taskId);

  return (
    <AutocompleteTextarea
      dataRole={dataRole}
      textareaRef={textareaRef}
      listDataRole={listDataRole}
      onChange={onChange}
      onSubmitShortcut={onSubmitShortcut}
      optionDataRole={optionDataRole}
      rows={rows}
      sources={[
        {
          trigger: "@",
          search: async (query) => searchProjectReferenceAutocompleteCandidates(query, { tasks, agents, roles }, 12),
        },
        {
          trigger: "#",
          allowEmptyQuery: true,
          search: async (query) => searchProjectTagAutocompleteCandidates(query, tasks, currentTaskTags, 12),
        },
        {
          trigger: "$",
          allowEmptyQuery: true,
          search: async (query) => mapTaskFileMentionAutocompleteCandidates(await searchFileMentions(query, 12)),
        },
      ]}
      value={value}
    />
  );
}
