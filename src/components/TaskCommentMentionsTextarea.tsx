import { AutocompleteTextarea } from "./AutocompleteTextarea";
import { searchProjectReferenceAutocompleteCandidates } from "../lib/referenceMentions";
import { searchTaskCommentFileMentions } from "../lib/tauri";
import type { AgentSummary, RoleSummary, TaskSummary } from "../types";

interface TaskCommentMentionsTextareaProps {
  taskId: string;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  value: string;
  rows?: number;
  dataRole: string;
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
  rows = 4,
  dataRole,
  listDataRole,
  optionDataRole,
  onChange,
  onSubmitShortcut,
}: TaskCommentMentionsTextareaProps) {
  return (
    <AutocompleteTextarea
      dataRole={dataRole}
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
          trigger: "$",
          search: async (query) => {
            const results = await searchTaskCommentFileMentions(taskId, query, 12);
            return results.map((candidate) => ({
              id: `${candidate.repositoryId}:${candidate.relativePath}`,
              insertText: candidate.insertText,
              label: candidate.relativePath,
              detail: candidate.repositoryName,
            }));
          },
        },
      ]}
      value={value}
    />
  );
}
