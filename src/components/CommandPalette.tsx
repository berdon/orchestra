import { useEffect, useMemo, useRef, useState } from "react";

import type { CommandPaletteItem } from "../lib/commandPalette";
import { fuzzySearch } from "../lib/fuzzy";

interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (item: CommandPaletteItem) => void;
}

export function CommandPalette({ open, items, loading, onClose, onSelect }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const matches = useMemo(() => fuzzySearch(query, items, 18).map((match) => match.item), [items, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }

    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, items]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const activeItem = itemRefs.current[selectedIndex];
    if (!activeItem) {
      return;
    }

    activeItem.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex, matches]);

  if (!open) {
    return null;
  }

  const activeItem = matches[selectedIndex] ?? null;
  let currentGroup = "";

  return (
    <div className="command-palette-overlay" data-role="command-palette-overlay" onClick={onClose}>
      <section className="command-palette" onClick={(event) => event.stopPropagation()}>
        <div className="command-palette__header">
          <input
            ref={inputRef}
            className="command-palette__input"
            data-role="command-palette-input"
            placeholder="Search pages, projects, workers, workflows, sessions, and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }

              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((current) => (matches.length === 0 ? 0 : Math.min(current + 1, matches.length - 1)));
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) => Math.max(current - 1, 0));
                return;
              }

              if (event.key === "Enter" && activeItem) {
                event.preventDefault();
                onSelect(activeItem);
              }
            }}
          />
          <button className="secondary-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="command-palette__results" data-role="command-palette-results">
          {loading ? <p className="muted-copy">Loading commands…</p> : null}
          {!loading && matches.length === 0 ? <p className="muted-copy">No matches yet.</p> : null}

          {!loading
            ? matches.map((item, index) => {
                const showGroup = item.group !== currentGroup;
                currentGroup = item.group;
                return (
                  <div key={item.id}>
                    {showGroup ? <p className="command-palette__group-label">{item.group}</p> : null}
                    <button
                      ref={(node) => {
                        itemRefs.current[index] = node;
                      }}
                      className={index === selectedIndex ? "command-palette__item command-palette__item--active" : "command-palette__item"}
                      data-role="command-palette-item"
                      data-command-id={item.id}
                      data-active={index === selectedIndex ? "true" : "false"}
                      type="button"
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => onSelect(item)}
                    >
                      <span className="command-palette__item-title">{item.title}</span>
                      {item.subtitle ? <span className="command-palette__item-subtitle">{item.subtitle}</span> : null}
                    </button>
                  </div>
                );
              })
            : null}
        </div>
      </section>
    </div>
  );
}
