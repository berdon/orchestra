import { useEffect, useId, useMemo, useRef, useState } from "react";

import { commitTaskTagCandidates, normalizeTaskTags, splitTaskTagPaste } from "../lib/taskTags";

interface TaskTagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
  helperText?: string;
  dataRolePrefix?: string;
}

type PendingFocusTarget =
  | { kind: "input" }
  | { kind: "chip"; index: number };

function sameTags(left: string[], right: string[]) {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

export function TaskTagInput({
  tags,
  onChange,
  disabled = false,
  label = "Tags",
  helperText = "Lower-case tags only. Use letters, numbers, - and _. Up to 20 tags.",
  dataRolePrefix = "task-tags",
}: TaskTagInputProps) {
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const normalizedTags = useMemo(() => normalizeTaskTags(tags), [tags]);
  const [draftValue, setDraftValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [focusedChipIndex, setFocusedChipIndex] = useState<number | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocusTarget | null>(null);

  const helperTextId = `${fieldId}-helper`;
  const errorTextId = `${fieldId}-error`;
  const describedBy = [helperText ? helperTextId : null, errorMessage ? errorTextId : null].filter(Boolean).join(" ") || undefined;

  useEffect(() => {
    if (focusedChipIndex === null) {
      return;
    }
    if (focusedChipIndex >= normalizedTags.length) {
      setFocusedChipIndex(normalizedTags.length ? normalizedTags.length - 1 : null);
    }
  }, [focusedChipIndex, normalizedTags.length]);

  useEffect(() => {
    if (!pendingFocus) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (pendingFocus.kind === "input") {
        inputRef.current?.focus();
      } else {
        chipRefs.current[pendingFocus.index]?.focus();
      }
      setPendingFocus(null);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pendingFocus, normalizedTags.length]);

  function focusInput() {
    setFocusedChipIndex(null);
    setPendingFocus({ kind: "input" });
  }

  function focusChip(index: number) {
    if (index < 0 || index >= normalizedTags.length) {
      focusInput();
      return;
    }
    setFocusedChipIndex(index);
    setPendingFocus({ kind: "chip", index });
  }

  function applyNextTags(nextTags: string[]) {
    if (!sameTags(normalizedTags, nextTags)) {
      onChange(nextTags);
    }
  }

  function commitCandidates(rawCandidates: string[]) {
    const result = commitTaskTagCandidates(normalizedTags, rawCandidates);
    if (!result.ok) {
      setErrorMessage(result.error);
      return false;
    }

    setDraftValue("");
    setErrorMessage(null);
    setFocusedChipIndex(null);
    applyNextTags(result.tags);
    return true;
  }

  function commitDraftValue() {
    if (!draftValue.trim()) {
      setDraftValue("");
      return true;
    }
    return commitCandidates([draftValue]);
  }

  function removeTag(index: number) {
    const nextTags = normalizedTags.filter((_, candidateIndex) => candidateIndex !== index);
    applyNextTags(nextTags);
    setDraftValue("");
    setErrorMessage(null);

    if (index - 1 >= 0) {
      setFocusedChipIndex(index - 1);
      setPendingFocus({ kind: "chip", index: index - 1 });
      return;
    }

    if (nextTags.length > 0) {
      setFocusedChipIndex(0);
      setPendingFocus({ kind: "chip", index: 0 });
      return;
    }

    setFocusedChipIndex(null);
    setPendingFocus({ kind: "input" });
  }

  return (
    <div className="task-tag-field" data-role={`${dataRolePrefix}-field`}>
      <label className="field-group" htmlFor={fieldId}>
        <span className="field-group__label">{label}</span>
      </label>
      <div
        className={`task-tag-field__shell${errorMessage ? " task-tag-field__shell--invalid" : ""}${disabled ? " task-tag-field__shell--disabled" : ""}`}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button") || target.closest("input")) {
            return;
          }
          inputRef.current?.focus();
        }}
      >
        <div className="task-tag-list">
          {normalizedTags.map((tag, index) => (
            <div className={`task-tag-chip${focusedChipIndex === index ? " task-tag-chip--focused" : ""}`} data-role="task-tag-chip" data-tag-value={tag} key={tag}>
              <button
                ref={(node) => {
                  chipRefs.current[index] = node;
                }}
                className="task-tag-chip__action"
                data-role="task-tag-chip-focus"
                data-tag-value={tag}
                type="button"
                tabIndex={focusedChipIndex === index ? 0 : -1}
                disabled={disabled}
                onClick={() => setFocusedChipIndex(index)}
                onFocus={() => setFocusedChipIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    focusChip(index - 1);
                    return;
                  }

                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    if (index === normalizedTags.length - 1) {
                      focusInput();
                    } else {
                      focusChip(index + 1);
                    }
                    return;
                  }

                  if (event.key === "Backspace" || event.key === "Delete") {
                    event.preventDefault();
                    removeTag(index);
                  }
                }}
              >
                <span>{tag}</span>
              </button>
              {!disabled ? (
                <button
                  className="task-tag-chip__remove"
                  data-role="task-tag-remove"
                  data-tag-value={tag}
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => removeTag(index)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          <input
            ref={inputRef}
            id={fieldId}
            className="text-input task-tag-input"
            data-role={`${dataRolePrefix}-input`}
            type="text"
            value={draftValue}
            disabled={disabled}
            placeholder="Add a tag and press Enter"
            aria-describedby={describedBy}
            aria-invalid={errorMessage ? true : undefined}
            onChange={(event) => {
              setDraftValue(event.target.value);
              setErrorMessage(null);
              setFocusedChipIndex(null);
            }}
            onFocus={() => setFocusedChipIndex(null)}
            onBlur={() => {
              void commitDraftValue();
            }}
            onPaste={(event) => {
              const pastedText = event.clipboardData.getData("text");
              if (!/[\n\r,]/.test(pastedText)) {
                return;
              }
              event.preventDefault();
              void commitCandidates(splitTaskTagPaste(pastedText));
            }}
            onKeyDown={(event) => {
              const target = event.currentTarget;
              const atStart = (target.selectionStart ?? 0) === 0 && (target.selectionEnd ?? 0) === 0;

              if (event.key === "Enter") {
                event.preventDefault();
                void commitDraftValue();
                return;
              }

              if (event.key === "," && draftValue.trim()) {
                event.preventDefault();
                void commitDraftValue();
                return;
              }

              if (event.key === "Escape" && errorMessage) {
                event.preventDefault();
                setErrorMessage(null);
                return;
              }

              if ((event.key === "Backspace" && !draftValue) || (event.key === "ArrowLeft" && !draftValue && atStart)) {
                if (!normalizedTags.length) {
                  return;
                }
                event.preventDefault();
                focusChip(normalizedTags.length - 1);
              }
            }}
          />
        </div>
      </div>
      {helperText ? <p className="task-tag-helper muted-copy" id={helperTextId}>{helperText}</p> : null}
      {errorMessage ? <p className="task-tag-error" data-role={`${dataRolePrefix}-error`} id={errorTextId}>{errorMessage}</p> : null}
    </div>
  );
}
