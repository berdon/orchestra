import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import type { ComposerAutocompleteCandidate } from "../lib/referenceMentions";

interface AutocompleteRange {
  trigger: string;
  start: number;
  end: number;
  query: string;
}

export interface AutocompleteTextareaSource {
  trigger: string;
  search: (query: string) => Promise<ComposerAutocompleteCandidate[]>;
  allowEmptyQuery?: boolean;
}

interface AutocompleteTextareaProps {
  value: string;
  rows?: number;
  dataRole: string;
  listDataRole: string;
  optionDataRole: string;
  onChange: (value: string) => void;
  onSubmitShortcut?: () => void;
  onEscape?: () => void;
  sources: AutocompleteTextareaSource[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
}

function isAutocompleteBoundary(character: string) {
  return /\s|[(){}\[\],;]/.test(character);
}

function activeAutocompleteRange(value: string, caret: number, triggers: Set<string>): AutocompleteRange | null {
  if (caret < 0 || caret > value.length) {
    return null;
  }

  let start = caret - 1;
  while (start >= 0) {
    const character = value[start] ?? "";
    if (triggers.has(character)) {
      const previous = start > 0 ? value[start - 1] ?? "" : "";
      if (previous && /[\w./$-]/.test(previous)) {
        return null;
      }

      let end = caret;
      while (end < value.length && !isAutocompleteBoundary(value[end] ?? "")) {
        end += 1;
      }

      return {
        trigger: character,
        start,
        end,
        query: value.slice(start + 1, caret),
      };
    }

    if (isAutocompleteBoundary(character)) {
      return null;
    }

    start -= 1;
  }

  return null;
}

function applyAutocompleteCandidate(value: string, range: AutocompleteRange, candidate: ComposerAutocompleteCandidate) {
  return `${value.slice(0, range.start)}${candidate.insertText} ${value.slice(range.end)}`;
}

export function AutocompleteTextarea({
  value,
  rows = 4,
  dataRole,
  listDataRole,
  optionDataRole,
  onChange,
  onSubmitShortcut,
  onEscape,
  sources,
  placeholder,
  ariaLabel,
  disabled = false,
  textareaRef,
}: AutocompleteTextareaProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const [activeRange, setActiveRange] = useState<AutocompleteRange | null>(null);
  const [candidates, setCandidates] = useState<ComposerAutocompleteCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerSet = useMemo(() => new Set(sources.map((source) => source.trigger)), [sources]);
  const sourceByTrigger = useMemo(() => new Map(sources.map((source) => [source.trigger, source])), [sources]);
  const activeCandidate = useMemo(
    () => (candidates.length ? candidates[Math.min(activeIndex, candidates.length - 1)] : null),
    [activeIndex, candidates],
  );

  useEffect(() => {
    if (!textareaRef) {
      return;
    }
    textareaRef.current = internalRef.current;
    return () => {
      if (textareaRef.current === internalRef.current) {
        textareaRef.current = null;
      }
    };
  }, [textareaRef]);

  useEffect(() => {
    if (disabled || !activeRange) {
      setCandidates([]);
      setActiveIndex(0);
      return;
    }

    const source = sourceByTrigger.get(activeRange.trigger);
    if (!source || (!source.allowEmptyQuery && !activeRange.query.trim())) {
      setCandidates([]);
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const results = await source.search(activeRange.query);
        if (!cancelled) {
          const exactTypedToken = `${activeRange.trigger}${activeRange.query}`;
          const shouldHideExactMatch = results.some((candidate) => candidate.insertText === exactTypedToken);
          setCandidates(shouldHideExactMatch ? [] : results);
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
  }, [activeRange, disabled, sourceByTrigger]);

  function syncAutocompleteState(nextValue: string, caret: number) {
    const nextRange = activeAutocompleteRange(nextValue, caret, triggerSet);
    setActiveRange(nextRange);
    if (!nextRange) {
      setCandidates([]);
      setActiveIndex(0);
    }
  }

  function handleChange(nextValue: string, caret: number) {
    onChange(nextValue);
    syncAutocompleteState(nextValue, caret);
  }

  function clearAutocomplete() {
    setCandidates([]);
    setActiveRange(null);
    setActiveIndex(0);
  }

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!wrapperRef.current || wrapperRef.current.contains(event.target as Node)) {
        return;
      }
      clearAutocomplete();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  function acceptCandidate(candidate: ComposerAutocompleteCandidate | null) {
    if (!candidate || !activeRange || !internalRef.current) {
      return;
    }

    const currentValue = internalRef.current.value;
    const nextValue = applyAutocompleteCandidate(currentValue, activeRange, candidate);
    const nextCaret = activeRange.start + candidate.insertText.length + 1;
    onChange(nextValue);
    clearAutocomplete();
    window.requestAnimationFrame(() => {
      internalRef.current?.focus();
      internalRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  return (
    <div className="task-comment-mentions-input" ref={wrapperRef}>
      <textarea
        ref={internalRef}
        className="text-area"
        data-role={dataRole}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
        onClick={(event) => syncAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
        onKeyUp={(event) => syncAutocompleteState(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
        onBlur={() => {
          window.setTimeout(() => {
            clearAutocomplete();
          }, 120);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmitShortcut?.();
            return;
          }
          if (candidates.length) {
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
              clearAutocomplete();
              return;
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onEscape?.();
          }
        }}
      />

      {candidates.length ? (
        <div className="task-comment-mentions-input__menu" data-role={listDataRole}>
          {candidates.map((candidate, index) => (
            <button
              key={candidate.id}
              className={index === activeIndex ? "task-comment-mentions-input__option task-comment-mentions-input__option--active" : "task-comment-mentions-input__option"}
              data-role={optionDataRole}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                acceptCandidate(candidate);
              }}
              onClick={() => acceptCandidate(candidate)}
            >
              <strong>{candidate.label}</strong>
              {candidate.detail ? <span className="muted-copy">{candidate.detail}</span> : <span />}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
