import { useEffect, useId, useMemo, useState, type FormEvent } from "react";

import type { NoteLocation, NoteTreeNode, NotesRoot } from "../types";

export type NotesCreateDialogMode = "note" | "directory";

export interface NotesCreateDialogProps {
  mode: NotesCreateDialogMode;
  roots: NotesRoot[];
  initialLocation: NoteLocation;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (location: NoteLocation) => void | Promise<void>;
  onClose: () => void;
}

function rootValueFromLocation(location: Pick<NoteLocation, "scope" | "repositoryId">) {
  return location.scope === "project" ? "project" : `repository:${location.repositoryId ?? ""}`;
}

function normalizeDirectoryPath(value: string) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Folder paths must stay inside docs/.");
  }
  return trimmed;
}

function normalizeCreateName(value: string, note: boolean) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new Error(note ? "A note name is required." : "A folder name is required.");
  }
  if (trimmed.includes("/")) {
    throw new Error("Name must not include path separators. Choose the parent folder separately.");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Name must stay inside docs/.");
  }
  if (note && !trimmed.toLowerCase().endsWith(".md")) {
    return `${trimmed}.md`;
  }
  return trimmed;
}

function joinPath(directoryPath: string, name: string) {
  return directoryPath ? `${directoryPath}/${name}` : name;
}

function collectDirectoryPaths(nodes: NoteTreeNode[], output: Set<string>) {
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    output.add(node.path);
    if (node.children?.length) {
      collectDirectoryPaths(node.children, output);
    }
  }
}

export function listDirectorySuggestions(root: NotesRoot | null | undefined) {
  if (!root) {
    return [] as string[];
  }
  const paths = new Set<string>();
  collectDirectoryPaths(root.children, paths);
  return Array.from(paths).sort((left, right) => left.localeCompare(right));
}

export function buildCreateLocation(
  root: Pick<NoteLocation, "scope" | "repositoryId">,
  directoryPath: string,
  name: string,
  mode: NotesCreateDialogMode,
): NoteLocation {
  const normalizedDirectoryPath = normalizeDirectoryPath(directoryPath);
  const normalizedName = normalizeCreateName(name, mode === "note");
  return {
    scope: root.scope,
    repositoryId: root.repositoryId ?? null,
    path: joinPath(normalizedDirectoryPath, normalizedName),
  } satisfies NoteLocation;
}

export function NotesCreateDialog({ mode, roots, initialLocation, submitting = false, error, onSubmit, onClose }: NotesCreateDialogProps) {
  const folderListId = useId();
  const [rootValue, setRootValue] = useState(() => rootValueFromLocation(initialLocation));
  const [directoryPath, setDirectoryPath] = useState(initialLocation.path);
  const [name, setName] = useState(mode === "note" ? "new-note.md" : "new-folder");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setRootValue(rootValueFromLocation(initialLocation));
    setDirectoryPath(initialLocation.path);
    setName(mode === "note" ? "new-note.md" : "new-folder");
    setLocalError(null);
  }, [initialLocation.path, initialLocation.repositoryId, initialLocation.scope, mode]);

  const selectedRoot = useMemo(
    () => roots.find((root) => rootValueFromLocation({ scope: root.scope, repositoryId: root.repositoryId ?? null }) === rootValue) ?? roots[0] ?? null,
    [rootValue, roots],
  );
  const directorySuggestions = useMemo(() => listDirectorySuggestions(selectedRoot), [selectedRoot]);
  const previewLocation = useMemo(() => {
    if (!selectedRoot) {
      return null;
    }
    try {
      return buildCreateLocation(
        { scope: selectedRoot.scope, repositoryId: selectedRoot.repositoryId ?? null },
        directoryPath,
        name,
        mode,
      );
    } catch {
      return null;
    }
  }, [directoryPath, mode, name, selectedRoot]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRoot || submitting) {
      return;
    }
    try {
      setLocalError(null);
      await onSubmit(buildCreateLocation(
        { scope: selectedRoot.scope, repositoryId: selectedRoot.repositoryId ?? null },
        directoryPath,
        name,
        mode,
      ));
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  }

  return (
    <div className="quick-chat-overlay" data-role="notes-create-dialog-overlay" onClick={() => !submitting && onClose()}>
      <section
        className="quick-chat-modal panel notes-create-dialog"
        data-role="notes-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notes-create-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Notes</p>
            <h3 id="notes-create-dialog-title">{mode === "note" ? "Create note" : "Create folder"}</h3>
            <p className="muted-copy">Choose the destination under a project or repository <code>docs/</code> tree, then enter a note or folder name.</p>
          </div>
        </div>

        <form className="notes-create-dialog__form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="notes-create-dialog__field">
            <span className="notes-create-dialog__label">Root</span>
            <select
              className="text-input"
              data-role="notes-create-root-select"
              value={selectedRoot ? rootValueFromLocation({ scope: selectedRoot.scope, repositoryId: selectedRoot.repositoryId ?? null }) : ""}
              disabled={submitting || !roots.length}
              onChange={(event) => {
                setRootValue(event.target.value);
                setDirectoryPath("");
                setLocalError(null);
              }}
            >
              {roots.map((root) => (
                <option key={rootValueFromLocation({ scope: root.scope, repositoryId: root.repositoryId ?? null })} value={rootValueFromLocation({ scope: root.scope, repositoryId: root.repositoryId ?? null })}>
                  {root.label}
                </option>
              ))}
            </select>
          </label>

          <label className="notes-create-dialog__field">
            <span className="notes-create-dialog__label">Folder under docs/</span>
            <input
              className="text-input"
              data-role="notes-create-folder-input"
              list={folderListId}
              value={directoryPath}
              disabled={submitting}
              placeholder="(root)"
              onChange={(event) => {
                setDirectoryPath(event.target.value);
                setLocalError(null);
              }}
            />
            <datalist id={folderListId}>
              {directorySuggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
            </datalist>
            <span className="notes-create-dialog__hint">
              Leave blank to create directly under <code>docs/</code>. Suggestions come from the current notes tree.
            </span>
          </label>

          <label className="notes-create-dialog__field">
            <span className="notes-create-dialog__label">{mode === "note" ? "Note name" : "Folder name"}</span>
            <input
              className="text-input"
              data-role="notes-create-name-input"
              value={name}
              disabled={submitting}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
                setLocalError(null);
              }}
            />
          </label>

          <div className="notes-create-dialog__preview" data-role="notes-create-path-preview">
            <span className="notes-create-dialog__label">Will create</span>
            <code>{selectedRoot && previewLocation ? `${selectedRoot.label} · docs/${previewLocation.path}` : "Enter a valid destination."}</code>
          </div>

          {error || localError ? <p className="supporting-copy">{error ?? localError}</p> : null}

          <div className="action-cluster action-cluster--wrap notes-create-dialog__actions">
            <button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" data-role="notes-create-submit" type="submit" disabled={submitting || !selectedRoot}>
              {submitting ? (mode === "note" ? "Creating note…" : "Creating folder…") : (mode === "note" ? "Create note" : "Create folder")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
