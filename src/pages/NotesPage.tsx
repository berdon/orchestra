import { useCallback, useEffect, useMemo, useState } from "react";

import { MarkdownContent } from "../components/MarkdownContent";
import { NotesCreateDialog, type NotesCreateDialogMode } from "../components/NotesCreateDialog";
import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import { SyntaxHighlightedMarkdownEditor } from "../components/SyntaxHighlightedMarkdownEditor";
import { useOrchestraClient } from "../lib/orchestraClient";
import type { NoteDetail, NoteLocation, NoteTreeNode, NotesRoot, NotesTree } from "../types";

type SelectionKind = "root" | "directory" | "note";

type NotesSelection = {
  kind: SelectionKind;
  location: NoteLocation;
};

type ResolvedSelection = {
  kind: SelectionKind;
  root: NotesRoot;
  node?: NoteTreeNode;
};

interface NotesPageProps {
  projectId: string | null;
  canWrite: boolean;
}

function rootKey(root: Pick<NotesRoot, "scope" | "repositoryId">) {
  return root.scope === "project" ? "project" : `repository:${root.repositoryId ?? "missing"}`;
}

function locationKey(location: NoteLocation) {
  return `${location.scope}:${location.repositoryId ?? ""}:${location.path}`;
}

function createRootSelection(root: NotesRoot): NotesSelection {
  return {
    kind: "root",
    location: {
      scope: root.scope,
      repositoryId: root.repositoryId ?? null,
      path: "",
    },
  };
}

function findNode(nodes: NoteTreeNode[], path: string): NoteTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.kind === "directory" && node.children?.length) {
      const nested = findNode(node.children, path);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function resolveSelection(tree: NotesTree | null, selection: NotesSelection | null): ResolvedSelection | null {
  if (!tree || !selection) {
    return null;
  }
  const root = tree.roots.find((entry) => entry.scope === selection.location.scope && (entry.repositoryId ?? null) === (selection.location.repositoryId ?? null)) ?? null;
  if (!root) {
    return null;
  }
  if (selection.kind === "root") {
    return { kind: "root", root };
  }
  const node = findNode(root.children, selection.location.path);
  if (!node) {
    return null;
  }
  return { kind: selection.kind, root, node };
}

function parentDirectoryLocation(location: NoteLocation) {
  const normalized = location.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized ? normalized.split("/") : [];
  if (parts.length <= 1) {
    return {
      scope: location.scope,
      repositoryId: location.repositoryId ?? null,
      path: "",
    } satisfies NoteLocation;
  }
  return {
    scope: location.scope,
    repositoryId: location.repositoryId ?? null,
    path: parts.slice(0, -1).join("/"),
  } satisfies NoteLocation;
}

function formatScopeLabel(location: Pick<NoteLocation, "scope" | "repositoryId">) {
  return location.scope === "project"
    ? "Project"
    : `Repository${location.repositoryId ? ` · ${location.repositoryId}` : ""}`;
}

function normalizePromptPath(value: string, note = false) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new Error("A path is required.");
  }
  if (trimmed.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Paths must stay inside docs/.");
  }
  if (note && !trimmed.toLowerCase().endsWith(".md")) {
    return `${trimmed}.md`;
  }
  return trimmed;
}

function parseDestinationScope(raw: string, fallback: NoteLocation) {
  const normalized = raw.trim();
  if (!normalized || normalized === "project") {
    return { scope: "project" as const, repositoryId: null };
  }
  if (normalized.startsWith("repository:")) {
    const repositoryId = normalized.slice("repository:".length).trim();
    if (!repositoryId) {
      throw new Error("Repository destinations must include a repository id, e.g. repository:repo-123.");
    }
    return { scope: "repository" as const, repositoryId };
  }
  if (normalized === "repository" && fallback.scope === "repository") {
    return { scope: "repository" as const, repositoryId: fallback.repositoryId ?? null };
  }
  throw new Error("Destination scope must be project or repository:<repositoryId>.");
}

function buildDefaultScopePrompt(location: NoteLocation) {
  return location.scope === "project" ? "project" : `repository:${location.repositoryId ?? ""}`;
}

function NotesTreeBranch({
  nodes,
  selection,
  expandedKeys,
  onSelect,
  onToggle,
  scope,
  repositoryId,
}: {
  nodes: NoteTreeNode[];
  selection: NotesSelection | null;
  expandedKeys: Set<string>;
  onSelect: (selection: NotesSelection) => void;
  onToggle: (key: string) => void;
  scope: NoteLocation["scope"];
  repositoryId?: string | null;
}) {
  return (
    <ul className="notes-tree__list">
      {nodes.map((node) => {
        const key = `node:${node.path}`;
        const isDirectory = node.kind === "directory";
        const isExpanded = isDirectory ? expandedKeys.has(key) : false;
        const isSelected = selection?.kind === node.kind
          && selection.location.path === node.path
          && selection.location.scope === scope
          && (selection.location.repositoryId ?? null) === (repositoryId ?? null);
        const location: NoteLocation = { scope, repositoryId: repositoryId ?? null, path: node.path };
        return (
          <li className="notes-tree__item" key={key}>
            <div className="notes-tree__row">
              {isDirectory ? (
                <button className="notes-tree__toggle" type="button" aria-label={isExpanded ? "Collapse directory" : "Expand directory"} onClick={() => onToggle(key)}>
                  {isExpanded ? "▾" : "▸"}
                </button>
              ) : <span className="notes-tree__toggle notes-tree__toggle--placeholder" aria-hidden="true">•</span>}
              <button
                className={isSelected ? "notes-tree__button notes-tree__button--active" : "notes-tree__button"}
                type="button"
                onClick={() => {
                  onSelect({ kind: node.kind, location });
                  if (isDirectory && !isExpanded) {
                    onToggle(key);
                  }
                }}
              >
                <span className={isDirectory ? "notes-tree__icon" : "notes-tree__icon notes-tree__icon--note"}>{isDirectory ? "📁" : "📝"}</span>
                <span className="notes-tree__label">{node.name}</span>
              </button>
            </div>
            {isDirectory && isExpanded && node.children?.length ? (
              <NotesTreeBranch
                nodes={node.children}
                selection={selection}
                expandedKeys={expandedKeys}
                onSelect={onSelect}
                onToggle={onToggle}
                scope={scope}
                repositoryId={repositoryId ?? null}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function NotesPage({ projectId, canWrite }: NotesPageProps) {
  const orchestraClient = useOrchestraClient();
  const [tree, setTree] = useState<NotesTree | null>(null);
  const [selection, setSelection] = useState<NotesSelection | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set(["root:project"]));
  const [selectedNote, setSelectedNote] = useState<NoteDetail | null>(null);
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [savedMarkdown, setSavedMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [createDialogMode, setCreateDialogMode] = useState<NotesCreateDialogMode | null>(null);
  const [createDialogError, setCreateDialogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const dirty = selectedNote != null && draftMarkdown !== savedMarkdown;
  const resolvedSelection = useMemo(() => resolveSelection(tree, selection), [tree, selection]);

  const loadTree = useCallback(async (options?: { nextSelection?: NotesSelection | null; preserveStatus?: boolean }) => {
    if (!projectId) {
      setTree(null);
      setSelection(null);
      setSelectedNote(null);
      setDraftMarkdown("");
      setSavedMarkdown("");
      return;
    }
    setLoading(true);
    setError(null);
    if (!options?.preserveStatus) {
      setStatusMessage(null);
    }
    try {
      const nextTree = await orchestraClient.notes.list(projectId);
      setTree(nextTree);
      setExpandedKeys((current) => {
        const next = new Set(current);
        for (const root of nextTree.roots) {
          next.add(`root:${rootKey(root)}`);
        }
        return next;
      });
      const requestedSelection = options?.nextSelection ?? selection ?? (nextTree.roots[0] ? createRootSelection(nextTree.roots[0]) : null);
      const resolved = resolveSelection(nextTree, requestedSelection);
      const fallbackSelection = nextTree.roots[0] ? createRootSelection(nextTree.roots[0]) : null;
      const nextSelection = resolved ? requestedSelection : fallbackSelection;
      setSelection(nextSelection);
      if (!resolveSelection(nextTree, nextSelection)?.node || resolveSelection(nextTree, nextSelection)?.kind !== "note") {
        setSelectedNote(null);
        setDraftMarkdown("");
        setSavedMarkdown("");
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [orchestraClient.notes, projectId, selection]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const loadNote = useCallback(async (noteLocation: NoteLocation) => {
    if (!projectId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const detail = await orchestraClient.notes.get(projectId, noteLocation);
      setSelectedNote(detail);
      setDraftMarkdown(detail.markdown);
      setSavedMarkdown(detail.markdown);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [orchestraClient.notes, projectId]);

  useEffect(() => {
    if (!projectId || !selection || selection.kind !== "note") {
      return;
    }
    if (selectedNote && locationKey(selectedNote.location) === locationKey(selection.location)) {
      return;
    }
    void loadNote(selection.location);
  }, [loadNote, projectId, selectedNote, selection]);

  const activeContainerLocation = useMemo(() => {
    if (!selection) {
      return null;
    }
    if (selection.kind === "note") {
      return parentDirectoryLocation(selection.location);
    }
    return selection.location;
  }, [selection]);

  const createDialogInitialLocation = useMemo(() => {
    if (activeContainerLocation) {
      return activeContainerLocation;
    }
    if (tree?.roots[0]) {
      return createRootSelection(tree.roots[0]).location;
    }
    return { scope: "project" as const, repositoryId: null, path: "" };
  }, [activeContainerLocation, tree]);

  const requestSelection = useCallback(async (nextSelection: NotesSelection) => {
    if (dirty && !window.confirm("Discard unsaved note changes?")) {
      return;
    }
    setStatusMessage(null);
    setSelection(nextSelection);
    if (nextSelection.kind !== "note") {
      setSelectedNote(null);
      setDraftMarkdown("");
      setSavedMarkdown("");
    }
  }, [dirty]);

  const toggleExpandedKey = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!projectId || !selectedNote || !canWrite || !dirty) {
      return;
    }
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const detail = await orchestraClient.notes.update(projectId, selectedNote.location, draftMarkdown);
      setSelectedNote(detail);
      setSavedMarkdown(detail.markdown);
      setDraftMarkdown(detail.markdown);
      setStatusMessage("Note saved.");
      await loadTree({ nextSelection: { kind: "note", location: detail.location }, preserveStatus: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [canWrite, dirty, draftMarkdown, loadTree, orchestraClient.notes, projectId, selectedNote]);

  const handleRevert = useCallback(() => {
    setDraftMarkdown(savedMarkdown);
    setStatusMessage("Reverted unsaved changes.");
  }, [savedMarkdown]);

  const handleOpenCreateDialog = useCallback((mode: NotesCreateDialogMode) => {
    if (!canWrite || !projectId || !tree?.roots.length) {
      return;
    }
    setCreateDialogError(null);
    setCreateDialogMode(mode);
  }, [canWrite, projectId, tree]);

  const handleCloseCreateDialog = useCallback(() => {
    if (saving) {
      return;
    }
    setCreateDialogMode(null);
    setCreateDialogError(null);
  }, [saving]);

  const handleCreateLocation = useCallback(async (location: NoteLocation) => {
    if (!projectId || !canWrite || !createDialogMode) {
      return;
    }
    if (dirty && !window.confirm("Discard unsaved note changes?")) {
      return;
    }
    setSaving(true);
    setError(null);
    setCreateDialogError(null);
    setStatusMessage(null);
    try {
      if (createDialogMode === "note") {
        const detail = await orchestraClient.notes.update(projectId, location, "");
        setSelection({ kind: "note", location: detail.location });
        setSelectedNote(detail);
        setDraftMarkdown(detail.markdown);
        setSavedMarkdown(detail.markdown);
        setStatusMessage(`Created note ${detail.location.path}.`);
        await loadTree({ nextSelection: { kind: "note", location: detail.location }, preserveStatus: true });
      } else {
        await orchestraClient.notes.createDirectory(projectId, location);
        setStatusMessage(`Created directory ${location.path}.`);
        await loadTree({ nextSelection: { kind: "directory", location }, preserveStatus: true });
      }
      setCreateDialogMode(null);
      setCreateDialogError(null);
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      setCreateDialogError(message);
    } finally {
      setSaving(false);
    }
  }, [canWrite, createDialogMode, dirty, loadTree, orchestraClient.notes, projectId]);

  const handleDeleteSelected = useCallback(async () => {
    if (!projectId || !selection || selection.kind === "root" || !canWrite) {
      return;
    }
    const message = selection.kind === "note"
      ? `Delete note ${selection.location.path}?`
      : `Delete directory ${selection.location.path} and everything under it?`;
    if (!window.confirm(message)) {
      return;
    }
    try {
      if (selection.kind === "note") {
        await orchestraClient.notes.delete(projectId, selection.location);
      } else {
        await orchestraClient.notes.deleteDirectory(projectId, selection.location);
      }
      const nextSelection = {
        kind: selection.kind === "note" ? "directory" : "root",
        location: selection.kind === "note" ? parentDirectoryLocation(selection.location) : { scope: selection.location.scope, repositoryId: selection.location.repositoryId ?? null, path: "" },
      } satisfies NotesSelection;
      setStatusMessage(`${selection.kind === "note" ? "Deleted note" : "Deleted directory"} ${selection.location.path}.`);
      await loadTree({ nextSelection, preserveStatus: true });
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }, [canWrite, loadTree, orchestraClient.notes, projectId, selection]);

  const promptForDestination = useCallback((defaultLocation: NoteLocation, defaultPath: string) => {
    const scopeInput = window.prompt("Destination scope (project or repository:<repositoryId>)", buildDefaultScopePrompt(defaultLocation));
    if (!scopeInput) {
      return null;
    }
    const nextScope = parseDestinationScope(scopeInput, defaultLocation);
    const pathInput = window.prompt("Destination path relative to docs/", defaultPath);
    if (!pathInput) {
      return null;
    }
    return {
      scope: nextScope.scope,
      repositoryId: nextScope.repositoryId ?? null,
      path: defaultPath.toLowerCase().endsWith(".md") ? normalizePromptPath(pathInput, true) : normalizePromptPath(pathInput, false),
    } satisfies NoteLocation;
  }, []);

  const handleMoveOrRenameSelected = useCallback(async () => {
    if (!projectId || !selection || selection.kind === "root" || !canWrite) {
      return;
    }
    try {
      const destination = promptForDestination(selection.location, selection.location.path);
      if (!destination) {
        return;
      }
      if (selection.kind === "note") {
        const detail = await orchestraClient.notes.move(projectId, selection.location, destination);
        setStatusMessage(`Moved note to ${detail.location.path}.`);
        await loadTree({ nextSelection: { kind: "note", location: detail.location }, preserveStatus: true });
        setSelectedNote(detail);
        setDraftMarkdown(detail.markdown);
        setSavedMarkdown(detail.markdown);
      } else {
        await orchestraClient.notes.moveDirectory(projectId, selection.location, destination);
        setStatusMessage(`Moved directory to ${destination.path}.`);
        await loadTree({ nextSelection: { kind: "directory", location: destination }, preserveStatus: true });
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }, [canWrite, loadTree, orchestraClient.notes, projectId, promptForDestination, selection]);

  const handleCopySelected = useCallback(async () => {
    if (!projectId || !selection || selection.kind === "root" || !canWrite) {
      return;
    }
    try {
      const destination = promptForDestination(selection.location, selection.location.path);
      if (!destination) {
        return;
      }
      if (selection.kind === "note") {
        const detail = await orchestraClient.notes.copy(projectId, selection.location, destination);
        setStatusMessage(`Copied note to ${detail.location.path}.`);
        await loadTree({ nextSelection: { kind: "note", location: detail.location }, preserveStatus: true });
      } else {
        await orchestraClient.notes.copyDirectory(projectId, selection.location, destination);
        setStatusMessage(`Copied directory to ${destination.path}.`);
        await loadTree({ nextSelection: { kind: "directory", location: destination }, preserveStatus: true });
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }, [canWrite, loadTree, orchestraClient.notes, projectId, promptForDestination, selection]);

  const navigation = (
    <div className="notes-page__nav">
      <div className="notes-page__nav-header">
        <div>
          <p className="eyebrow">Notes</p>
          <h2>Project notes</h2>
        </div>
        <button className="secondary-button" type="button" onClick={() => void loadTree()} disabled={loading}>
          Refresh
        </button>
      </div>
      {!tree?.roots.length ? <p className="empty-state">No project selected.</p> : null}
      <div className="notes-page__nav-tree" data-role="notes-nav-tree">
        {tree?.roots.map((root) => {
          const key = `root:${rootKey(root)}`;
          const expanded = expandedKeys.has(key);
          const selected = selection?.kind === "root" && selection.location.scope === root.scope && (selection.location.repositoryId ?? null) === (root.repositoryId ?? null);
          return (
            <section className="notes-root" key={key}>
              <div className="notes-tree__row notes-tree__row--root">
                <button className="notes-tree__toggle" type="button" aria-label={expanded ? "Collapse section" : "Expand section"} onClick={() => toggleExpandedKey(key)}>
                  {expanded ? "▾" : "▸"}
                </button>
                <button
                  className={selected ? "notes-tree__button notes-tree__button--active notes-tree__button--root" : "notes-tree__button notes-tree__button--root"}
                  type="button"
                  onClick={() => {
                    void requestSelection(createRootSelection(root));
                    if (!expanded) {
                      toggleExpandedKey(key);
                    }
                  }}
                >
                  <span className="notes-tree__icon">📚</span>
                  <span className="notes-tree__label">{root.label}</span>
                </button>
              </div>
              {expanded ? (
                root.children.length ? (
                  <NotesTreeBranch
                    nodes={root.children}
                    selection={selection}
                    expandedKeys={expandedKeys}
                    onSelect={(nextSelection) => void requestSelection(nextSelection)}
                    onToggle={toggleExpandedKey}
                    scope={root.scope}
                    repositoryId={root.repositoryId ?? null}
                  />
                ) : (
                  <p className="notes-root__empty">No notes yet under docs/.</p>
                )
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );

  const detail = !projectId ? (
    <section className="panel notes-page__detail-empty">
      <h2>Notes</h2>
      <p>Select a project to browse project and repository notes.</p>
    </section>
  ) : (
    <section className="panel notes-page__detail">
      <div className="notes-page__detail-header">
        <div>
          <p className="eyebrow">{resolvedSelection ? formatScopeLabel(selection?.location ?? { scope: "project", repositoryId: null }) : "Notes"}</p>
          <h2>
            {resolvedSelection?.kind === "note"
              ? resolvedSelection.node?.name
              : resolvedSelection?.kind === "directory"
                ? resolvedSelection.node?.name
                : resolvedSelection?.root.label ?? "Notes"}
          </h2>
          {selection ? <p className="muted-copy">docs/{selection.location.path || ""}</p> : null}
        </div>
        <div className="notes-page__actions">
          {canWrite ? (
            <>
              <button className="secondary-button" type="button" onClick={() => handleOpenCreateDialog("note")} disabled={!tree?.roots.length || saving}>New note</button>
              <button className="secondary-button" type="button" onClick={() => handleOpenCreateDialog("directory")} disabled={!tree?.roots.length || saving}>New folder</button>
              {selection && selection.kind !== "root" ? (
                <>
                  <button className="secondary-button" type="button" onClick={() => void handleMoveOrRenameSelected()} disabled={saving}>Move / rename</button>
                  <button className="secondary-button" type="button" onClick={() => void handleCopySelected()} disabled={saving}>Copy</button>
                  <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleDeleteSelected()} disabled={saving}>Delete</button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {loading ? <p className="supporting-copy">Loading notes…</p> : null}
      {error ? <p className="supporting-copy">{error}</p> : null}
      {statusMessage ? <p className="supporting-copy">{statusMessage}</p> : null}
      {resolvedSelection?.kind === "note" && selectedNote ? (
        <div className="notes-editor">
          <div className="notes-editor__toolbar">
            <div className="notes-editor__toolbar-group">
              <span className={dirty ? "status-badge status-badge--warning" : "status-badge status-badge--success"}>{dirty ? "Unsaved" : "Saved"}</span>
            </div>
            <div className="notes-editor__toolbar-group">
              <button
                className="secondary-button"
                type="button"
                data-role="notes-preview-toggle"
                aria-pressed={previewVisible}
                onClick={() => setPreviewVisible((current) => !current)}
              >
                {previewVisible ? "Hide preview" : "Show preview"}
              </button>
              <button className="secondary-button" type="button" onClick={handleRevert} disabled={!dirty || saving}>Revert</button>
              <button className="primary-button" type="button" onClick={() => void handleSave()} disabled={!canWrite || !dirty || saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
          <div className={previewVisible ? "notes-editor__panes" : "notes-editor__panes notes-editor__panes--preview-hidden"}>
            <div className="notes-editor__pane">
              <label className="notes-editor__label" htmlFor="notes-markdown-editor">Markdown</label>
              <SyntaxHighlightedMarkdownEditor
                id="notes-markdown-editor"
                dataRole="notes-markdown-editor"
                value={draftMarkdown}
                onChange={setDraftMarkdown}
                readOnly={!canWrite}
                spellCheck={false}
              />
            </div>
            {previewVisible ? (
              <div className="notes-editor__pane">
                <p className="notes-editor__label">Preview</p>
                <div className="notes-editor__preview" data-role="notes-preview-panel">
                  {draftMarkdown.trim() ? <MarkdownContent message={draftMarkdown} /> : <p className="empty-state">Nothing to preview yet.</p>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="notes-page__detail-empty-state">
          <p>Select a note to edit its markdown content, or use the actions above to create a note or folder.</p>
        </div>
      )}
    </section>
  );

  return (
    <>
      <ResizableSidebarLayout
        className="notes-page"
        storageKey="orchestra.notes.secondary-nav-width"
        navigation={navigation}
        detail={detail}
        navigationClassName="notes-page__navigation"
        detailClassName="notes-page__detail-shell"
        minWidth={240}
        maxWidth={420}
        defaultWidth={280}
      />
      {createDialogMode && tree?.roots.length ? (
        <NotesCreateDialog
          mode={createDialogMode}
          roots={tree.roots}
          initialLocation={createDialogInitialLocation}
          submitting={saving}
          error={createDialogError}
          onSubmit={handleCreateLocation}
          onClose={handleCloseCreateDialog}
        />
      ) : null}
    </>
  );
}
