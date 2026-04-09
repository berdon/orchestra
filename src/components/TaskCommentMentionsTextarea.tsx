import { useEffect, useMemo, useRef, useState } from "react";

import { searchTaskCommentFileMentions } from "../lib/tauri";
import type { TaskCommentFileMentionCandidate } from "../types";

interface MentionRange {
  start: number;
  end: number;
  query: string;
}

interface TaskCommentMentionsTextareaProps {
  taskId: string;
  value: string;
  rows?: number;
  dataRole: string;
  listDataRole: string;
  optionDataRole: string;
  onChange: (value: string) => void;
  onSubmitShortcut?: () => void;
}

function isMentionBoundary(character: string) {
  return /\s|[(){}\[\],;]/.test(character);
}

function activeMentionRange(value: string, caret: number): MentionRange | null {
  if (caret < 0 || caret > value.length) {
    return null;
  }

  let start = caret - 1;
  while (start >= 0) {
    const character = value[start] ?? "";
    if (character === "@") {
      const previous = start > 0 ? value[start - 1] ?? "" : "";
      if (previous && /[\w./-]/.test(previous)) {
        return null;
      }
      let end = caret;
      while (end < value.length && !isMentionBoundary(value[end] ?? "")) {
        end += 1;
      }
      return {
        start,
        end,
        query: value.slice(start + 1, caret),
      };
    }
    if (isMentionBoundary(character)) {
      return null;
    }
    start -= 1;
  }

  return null;
}

function applyMention(value: string, range: MentionRange, candidate: TaskCommentFileMentionCandidate) {
  return `${value.slice(0, range.start)}${candidate.insertText} ${value.slice(range.end)}`;
}

export function TaskCommentMentionsTextarea({
  taskId,
  value,
  rows = 4,
  dataRole,
  listDataRole,
  optionDataRole,
  onChange,
  onSubmitShortcut,
}: TaskCommentMentionsTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null);
  const [candidates, setCandidates] = useState<TaskCommentFileMentionCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const activeCandidate = useMemo(
    () => (candidates.length ? candidates[Math.min(activeIndex, candidates.length - 1)] : null),
    [activeIndex, candidates],
  );

  useEffect(() => {
    if (!mentionRange?.query.trim()) {
      setCandidates([]);
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const results = await searchTaskCommentFileMentions(taskId, mentionRange.query, 12);
        if (!cancelled) {
          setCandidates(results);
          setActiveIndex(0);
        }
      } catch {
        if (!cancelled) {
          setCandidates([]);
          setActiveIndex(0);
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [mentionRange?.query, taskId]);

  function syncMentionState(nextValue: string, caret: number) {
    const nextRange = activeMentionRange(nextValue, caret);
    setMentionRange(nextRange);
    if (!nextRange) {
      setCandidates([]);
      setActiveIndex(0);
    }
  }

  function handleChange(nextValue: string, caret: number) {
    onChange(nextValue);
    syncMentionState(nextValue, caret);
  }

  function acceptCandidate(candidate: TaskCommentFileMentionCandidate | null) {
    if (!candidate || !mentionRange || !textareaRef.current) {
      return;
    }

    const currentValue = textareaRef.current.value;
    const nextValue = applyMention(currentValue, mentionRange, candidate);
    const nextCaret = mentionRange.start + candidate.insertText.length + 1;
    onChange(nextValue);
    setCandidates([]);
    setMentionRange(null);
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return (
    <div className="task-comment-mentions-input">
      <textarea
        ref={textareaRef}
        className="text-area"
        data-role={dataRole}
        rows={rows}
        value={value}
        onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onClick={(event) => syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
        onKeyUp={(event) => syncMentionState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
        onBlur={() => {
          window.setTimeout(() => {
            setCandidates([]);
            setMentionRange(null);
            setActiveIndex(0);
          }, 120);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmitShortcut?.();
            return;
          }
          if (!candidates.length) {
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) => (current + 1) % candidates.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => (current - 1 + candidates.length) % candidates.length);
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            acceptCandidate(activeCandidate);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setCandidates([]);
            setMentionRange(null);
            setActiveIndex(0);
          }
        }}
      />

      {candidates.length ? (
        <div className="task-comment-mentions-input__menu" data-role={listDataRole}>
          {candidates.map((candidate, index) => (
            <button
              key={`${candidate.repositoryId}:${candidate.relativePath}`}
              className={index === activeIndex ? "task-comment-mentions-input__option task-comment-mentions-input__option--active" : "task-comment-mentions-input__option"}
              data-role={optionDataRole}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                acceptCandidate(candidate);
              }}
              onClick={() => acceptCandidate(candidate)}
            >
              <strong>{candidate.relativePath}</strong>
              <span className="muted-copy">{candidate.repositoryName}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
