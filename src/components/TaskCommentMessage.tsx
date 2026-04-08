import { MarkdownContent } from "./MarkdownContent";
import type { TaskFileReference } from "../types";

interface TaskCommentMessageProps {
  message: string;
  fileReferences: TaskFileReference[];
  onOpenFileReference: (reference: TaskFileReference) => void;
  dataRole?: string;
}

function buildMentionLookup(fileReferences: TaskFileReference[]) {
  const byMention = new Map<string, TaskFileReference>();
  const unprefixedCounts = new Map<string, number>();

  for (const reference of fileReferences) {
    const unprefixed = `@${reference.relativePath}`.toLowerCase();
    unprefixedCounts.set(unprefixed, (unprefixedCounts.get(unprefixed) ?? 0) + 1);
    byMention.set(`@${reference.repositorySlug}:${reference.relativePath}`.toLowerCase(), reference);
  }

  for (const reference of fileReferences) {
    const unprefixed = `@${reference.relativePath}`.toLowerCase();
    if ((unprefixedCounts.get(unprefixed) ?? 0) === 1) {
      byMention.set(unprefixed, reference);
    }
  }

  return byMention;
}

export function TaskCommentMessage({ message, fileReferences, onOpenFileReference, dataRole }: TaskCommentMessageProps) {
  const lookup = buildMentionLookup(fileReferences);

  return (
    <MarkdownContent
      className="task-comment-message markdown-content"
      dataRole="task-comment-markdown"
      mentionLinkDataRole={dataRole}
      mentionResolver={(mention) => {
        const reference = lookup.get(mention.toLowerCase()) ?? null;
        if (!reference) {
          return null;
        }
        return {
          key: reference.id,
          label: mention,
          onClick: () => onOpenFileReference(reference),
        };
      }}
      message={message}
    />
  );
}
