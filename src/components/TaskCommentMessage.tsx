import type { ReactNode } from "react";

import type { TaskFileReference } from "../types";

interface TaskCommentMessageProps {
  message: string;
  fileReferences: TaskFileReference[];
  onOpenFileReference: (reference: TaskFileReference) => void;
  dataRole?: string;
}

const MENTION_PATTERN = /@(?:[a-z0-9._-]+:)?[a-z0-9._/-]+/gi;
const TRAILING_PUNCTUATION = /[),.!?;:]+$/;

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

function splitMentionToken(token: string) {
  const trailing = token.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  const mention = trailing ? token.slice(0, token.length - trailing.length) : token;
  return { mention, trailing };
}

export function TaskCommentMessage({ message, fileReferences, onOpenFileReference, dataRole }: TaskCommentMessageProps) {
  const lookup = buildMentionLookup(fileReferences);
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(MENTION_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(message.slice(lastIndex, index));
    }

    const { mention, trailing } = splitMentionToken(token);
    const reference = lookup.get(mention.toLowerCase()) ?? null;
    if (reference) {
      parts.push(
        <button
          className="task-comment-message__mention-link"
          data-role={dataRole}
          data-reference-id={reference.id}
          key={`${reference.id}-${index}`}
          type="button"
          onClick={() => onOpenFileReference(reference)}
        >
          {mention}
        </button>,
      );
      if (trailing) {
        parts.push(trailing);
      }
    } else {
      parts.push(token);
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < message.length) {
    parts.push(message.slice(lastIndex));
  }

  return <p className="task-comment-message">{parts}</p>;
}
