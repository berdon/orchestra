import { useEffect, useMemo, useState } from "react";

import { MarkdownContent } from "../components/MarkdownContent";
import { ResizableSidebarLayout } from "../components/ResizableSidebarLayout";
import {
  archiveLocalSkill,
  createLocalSkill,
  deleteLocalSkill,
  getSkill,
  listSkills,
  refreshExternalSkills,
  unarchiveLocalSkill,
  updateLocalSkill,
} from "../lib/skills";
import {
  buildLocalSkillDraftState,
  createBlankLocalSkillDraft,
  filterSkills,
  localSkillDraftHasChanges,
  localSkillDraftHasContent,
  normalizeLocalSkillDraftForSave,
  type SkillSourceFilter,
  type SkillStatusFilter,
} from "../lib/skillsUi";
import type { LocalSkillUpsertInput, SkillBindingScopeCount, SkillDetail, SkillStatus, SkillSummary } from "../types";

const SOURCE_FILTER_OPTIONS: Array<{ value: SkillSourceFilter; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "external", label: "External" },
];

const STATUS_FILTER_OPTIONS: Array<{ value: SkillStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "shadowed", label: "Shadowed" },
  { value: "missing", label: "Missing" },
  { value: "invalid", label: "Invalid" },
];

function getSkillStatusLabel(status: SkillStatus) {
  switch (status) {
    case "unloadable":
      return "Unloadable";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

function getSkillStatusBadgeClass(status: SkillStatus) {
  switch (status) {
    case "active":
      return "status-badge status-badge--success";
    case "shadowed":
    case "missing":
      return "status-badge status-badge--warning";
    case "invalid":
    case "unloadable":
      return "status-badge status-badge--error";
    default:
      return "status-badge status-badge--neutral";
  }
}

function getBindingScopeLabel(scopeKind: SkillBindingScopeCount["scopeKind"]) {
  switch (scopeKind) {
    case "workflow_lane":
      return "Workflow lane";
    default:
      return scopeKind.charAt(0).toUpperCase() + scopeKind.slice(1);
  }
}

function getSkillListMeta(skill: SkillSummary) {
  if (skill.sourceKind === "local") {
    return skill.slug ? `Slug: ${skill.slug}` : "Local skill";
  }

  return skill.relativeSourcePath ?? skill.sourcePath;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<SkillDetail | null>(null);
  const [localDraft, setLocalDraft] = useState<LocalSkillUpsertInput>(createBlankLocalSkillDraft);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingExternal, setRefreshingExternal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isCreatingLocalSkill, setIsCreatingLocalSkill] = useState(false);
  const [deleteConfirmationRequired, setDeleteConfirmationRequired] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);

  const localDraftState = useMemo(() => buildLocalSkillDraftState(localDraft), [localDraft]);
  const selectedSkillSummary = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) ?? null,
    [selectedSkillId, skills],
  );
  const selectedExternalSkill = !isCreatingLocalSkill && selectedSkillDetail?.sourceKind === "external"
    ? selectedSkillDetail
    : null;
  const selectedLocalSkill = !isCreatingLocalSkill && selectedSkillDetail?.sourceKind === "local"
    ? selectedSkillDetail
    : null;
  const filteredSkills = useMemo(
    () => filterSkills(skills, { query: searchQuery, source: sourceFilter, status: statusFilter }),
    [searchQuery, skills, sourceFilter, statusFilter],
  );
  const skillsById = useMemo(
    () => new Map(skills.map((skill) => [skill.id, skill] as const)),
    [skills],
  );
  const draftIsDirty = useMemo(
    () => (isCreatingLocalSkill ? localSkillDraftHasContent(localDraft) : localSkillDraftHasChanges(localDraft, selectedLocalSkill)),
    [isCreatingLocalSkill, localDraft, selectedLocalSkill],
  );

  async function loadSkillCatalog(preferredSkillId?: string | null) {
    setLoadingList(true);
    setActionError(null);

    try {
      const nextSkills = await listSkills(true);
      setSkills(nextSkills);
      if (isCreatingLocalSkill) {
        return;
      }

      setSelectedSkillId((current) => {
        const candidate = preferredSkillId === undefined ? current : preferredSkillId;
        if (candidate && nextSkills.some((skill) => skill.id === candidate)) {
          return candidate;
        }
        return nextSkills[0]?.id ?? null;
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to load skills.");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    void loadSkillCatalog();
  }, []);

  useEffect(() => {
    if (isCreatingLocalSkill) {
      setSelectedSkillDetail(null);
      return;
    }

    if (!selectedSkillId) {
      setSelectedSkillDetail(null);
      return;
    }

    let cancelled = false;
    setLoadingDetail(true);
    setSelectedSkillDetail(null);
    setActionError(null);
    setDeleteConfirmationRequired(false);

    void getSkill(selectedSkillId)
      .then((detail) => {
        if (cancelled) {
          return;
        }

        applySelectedSkillDetail(detail);
      })
      .catch((error) => {
        if (!cancelled) {
          setActionError(error instanceof Error ? error.message : "Unable to load skill detail.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [detailReloadKey, isCreatingLocalSkill, selectedSkillId]);

  function applySelectedSkillDetail(detail: SkillDetail | null) {
    setSelectedSkillDetail(detail);
    if (detail?.sourceKind === "local") {
      setLocalDraft({
        name: detail.name,
        slug: detail.slug ?? "",
        markdownBody: detail.markdownBody ?? "",
      });
    }
  }

  function reloadSelectedSkillDetail() {
    setDetailReloadKey((current) => current + 1);
  }

  function confirmDiscardDirtyDraft() {
    if (!draftIsDirty) {
      return true;
    }

    return window.confirm("Discard unsaved skill changes?");
  }

  function beginCreateLocalSkill() {
    if (!confirmDiscardDirtyDraft()) {
      return;
    }

    setActionError(null);
    setDeleteConfirmationRequired(false);
    setIsCreatingLocalSkill(true);
    setSelectedSkillId(null);
    setSelectedSkillDetail(null);
    setLocalDraft(createBlankLocalSkillDraft());
  }

  function handleSelectSkill(skillId: string) {
    if (skillId === selectedSkillId && !isCreatingLocalSkill) {
      return;
    }

    if (!confirmDiscardDirtyDraft()) {
      return;
    }

    setActionError(null);
    setDeleteConfirmationRequired(false);
    setIsCreatingLocalSkill(false);
    setSelectedSkillId(skillId);
  }

  async function handleSaveSkill() {
    const fieldErrors = Object.values(localDraftState.validationErrors).filter(Boolean);
    if (fieldErrors.length > 0) {
      setActionError(fieldErrors[0] ?? "Unable to save skill.");
      return;
    }

    const input = normalizeLocalSkillDraftForSave(localDraft);
    setSaving(true);
    setActionError(null);

    try {
      const saved = isCreatingLocalSkill
        ? await createLocalSkill(input)
        : selectedLocalSkill
          ? await updateLocalSkill(selectedLocalSkill.id, input)
          : null;

      if (!saved) {
        throw new Error("Select a local skill before saving changes.");
      }

      setIsCreatingLocalSkill(false);
      setDeleteConfirmationRequired(false);
      applySelectedSkillDetail(saved);
      await loadSkillCatalog(saved.id);
      setSelectedSkillId(saved.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to save skill.");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchiveToggle(nextArchived: boolean) {
    if (!selectedLocalSkill) {
      return;
    }

    setSaving(true);
    setActionError(null);
    try {
      const updated = nextArchived
        ? await archiveLocalSkill(selectedLocalSkill.id)
        : await unarchiveLocalSkill(selectedLocalSkill.id);
      applySelectedSkillDetail(updated);
      await loadSkillCatalog(updated.id);
      setSelectedSkillId(updated.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Unable to ${nextArchived ? "archive" : "unarchive"} skill.`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSkill() {
    if (!selectedLocalSkill) {
      return;
    }

    if (!deleteConfirmationRequired) {
      setDeleteConfirmationRequired(true);
      return;
    }

    setSaving(true);
    setActionError(null);
    try {
      await deleteLocalSkill(selectedLocalSkill.id);
      setDeleteConfirmationRequired(false);
      setSelectedSkillId(null);
      setSelectedSkillDetail(null);
      await loadSkillCatalog();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to delete skill.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRefreshExternalSkills() {
    setRefreshingExternal(true);
    setActionError(null);
    try {
      await refreshExternalSkills();
      await loadSkillCatalog(selectedSkillId);
      if (selectedSkillId && !isCreatingLocalSkill) {
        reloadSelectedSkillDetail();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to refresh external skills.");
    } finally {
      setRefreshingExternal(false);
    }
  }

  const detailWarnings = useMemo(() => {
    if (!selectedExternalSkill) {
      return [] as Array<{ tone: "neutral" | "warning" | "error"; title: string; message: string }>;
    }

    const warnings: Array<{ tone: "neutral" | "warning" | "error"; title: string; message: string }> = [
      {
        tone: "neutral",
        title: "Read-only external skill",
        message: "External skills come from ~/.agents/skills and cannot be edited in Orchestra Settings.",
      },
    ];

    if (selectedExternalSkill.status === "shadowed") {
      const shadowWinner = selectedExternalSkill.shadowedBySkillId ? skillsById.get(selectedExternalSkill.shadowedBySkillId) ?? null : null;
      warnings.push({
        tone: "warning",
        title: "Shadowed by another skill",
        message: shadowWinner
          ? `${shadowWinner.name} currently takes precedence for this slug.`
          : selectedExternalSkill.statusReason ?? "Another skill currently takes precedence for this slug.",
      });
    }

    if (selectedExternalSkill.status === "missing") {
      warnings.push({
        tone: "warning",
        title: "Missing on disk",
        message: "This external skill directory was indexed previously but is no longer present on disk.",
      });
    }

    if (selectedExternalSkill.status === "invalid" || selectedExternalSkill.status === "unloadable") {
      warnings.push({
        tone: "error",
        title: selectedExternalSkill.status === "invalid" ? "Invalid external skill" : "Unreadable external skill",
        message: selectedExternalSkill.statusReason ?? "Orchestra could not validate this external skill.",
      });
    }

    return warnings;
  }, [selectedExternalSkill, skillsById]);

  const currentDetail = isCreatingLocalSkill ? null : selectedSkillDetail;

  return (
    <ResizableSidebarLayout
      className="skills-shell"
      storageKey="orchestra.layout.skills.secondary-nav-width"
      navigationClassName="skills-nav-panel"
      detailClassName="panel skills-detail-panel"
      navigation={(
        <>
          <div className="panel__header panel__header--stacked">
            <div>
              <p className="eyebrow">Managed skills catalog</p>
              <h3>Skills</h3>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button className="secondary-button" data-role="refresh-external-skills" type="button" onClick={() => void handleRefreshExternalSkills()} disabled={refreshingExternal || saving}>
                {refreshingExternal ? "Refreshing…" : "Refresh external"}
              </button>
              <button className="primary-button" data-role="new-skill" type="button" onClick={beginCreateLocalSkill} disabled={saving}>
                New local skill
              </button>
            </div>
          </div>

          <div className="skills-filter-grid">
            <label className="field-group field-group--compact">
              <span className="field-group__label">Search</span>
              <input
                className="text-input"
                data-role="skills-search"
                type="search"
                placeholder="Search by name or slug"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <label className="field-group field-group--compact">
              <span className="field-group__label">Source</span>
              <select className="select-input" data-role="skills-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SkillSourceFilter)}>
                {SOURCE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="field-group field-group--compact">
              <span className="field-group__label">Status</span>
              <select className="select-input" data-role="skills-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SkillStatusFilter)}>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          {loadingList ? <p className="muted-copy">Loading skills…</p> : null}
          {actionError ? <p className="error-copy">{actionError}</p> : null}

          <nav className="skills-list" aria-label="Skills" data-role="skills-list">
            {filteredSkills.length === 0 ? (
              <div className="skills-list-empty muted-copy">
                No skills match the current filters.
              </div>
            ) : filteredSkills.map((skill) => {
              const selected = !isCreatingLocalSkill && skill.id === selectedSkillId;
              return (
                <button
                  className={selected ? "skills-list-item skills-list-item--active" : "skills-list-item"}
                  data-role={`skill-row-${skill.id}`}
                  key={skill.id}
                  type="button"
                  onClick={() => handleSelectSkill(skill.id)}
                >
                  <div className="skills-list-item__header">
                    <strong>{skill.name}</strong>
                    <div className="skills-list-item__badges">
                      <span className={skill.sourceKind === "local" ? "status-badge status-badge--accent" : "status-badge status-badge--neutral"}>
                        {skill.sourceKind === "local" ? "Local" : "External"}
                      </span>
                      {skill.sourceKind === "external" ? <span className="status-badge status-badge--neutral">Read-only</span> : null}
                      {skill.archived ? <span className="status-badge status-badge--neutral">Archived</span> : null}
                      {!skill.archived ? <span className={getSkillStatusBadgeClass(skill.status)}>{getSkillStatusLabel(skill.status)}</span> : null}
                    </div>
                  </div>
                  <span className="skills-list-item__meta">{getSkillListMeta(skill)}</span>
                  {skill.description ? <span className="skills-list-item__description">{skill.description}</span> : null}
                </button>
              );
            })}
          </nav>
        </>
      )}
      detail={(
        isCreatingLocalSkill ? (
          <div className="workflow-editor-grid" data-role="skill-detail">
            <div className="panel__header panel__header--stacked">
              <div>
                <p className="eyebrow">Local skill</p>
                <h3>Create skill</h3>
              </div>
              <div className="action-cluster action-cluster--wrap">
                <span className="status-badge status-badge--accent">Local draft</span>
                <button className="primary-button" data-role="save-skill" type="button" onClick={() => void handleSaveSkill()} disabled={saving}>
                  {saving ? "Creating…" : "Create skill"}
                </button>
              </div>
            </div>

            <section className="workflow-section skills-form-section">
              <div>
                <p className="eyebrow">Phase 1 editor</p>
                <h3>Name and markdown</h3>
              </div>

              <div className="skills-form-grid">
                <label className="field-group">
                  <span className="field-group__label">Skill name</span>
                  <input className="text-input" data-role="skill-name" type="text" value={localDraft.name} onChange={(event) => setLocalDraft((draft) => ({ ...draft, name: event.target.value }))} />
                  {localDraftState.validationErrors.name ? <span className="field-error">{localDraftState.validationErrors.name}</span> : null}
                </label>

                <label className="field-group">
                  <span className="field-group__label">Slug</span>
                  <input className="text-input" data-role="skill-slug" type="text" placeholder="Leave blank to derive from the name" value={localDraft.slug ?? ""} onChange={(event) => setLocalDraft((draft) => ({ ...draft, slug: event.target.value }))} />
                  <span className="field-group__hint">{localDraftState.normalizedSlug ? `Saved as ${localDraftState.normalizedSlug}` : localDraftState.slugPreview ? `Will derive ${localDraftState.slugPreview}` : "A slug will be derived from the skill name."}</span>
                  {localDraftState.validationErrors.slug ? <span className="field-error">{localDraftState.validationErrors.slug}</span> : null}
                </label>

                <label className="field-group skills-form-grid__full">
                  <span className="field-group__label">Markdown body</span>
                  <textarea className="text-area skills-markdown-input" data-role="skill-markdown-body" rows={18} value={localDraft.markdownBody} onChange={(event) => setLocalDraft((draft) => ({ ...draft, markdownBody: event.target.value }))} />
                  <span className="field-group__hint">The editor stays phase-1 scoped to name, slug, and markdown content only.</span>
                  {localDraftState.validationErrors.markdownBody ? <span className="field-error">{localDraftState.validationErrors.markdownBody}</span> : null}
                </label>
              </div>
            </section>

            <section className="workflow-section">
              <div>
                <p className="eyebrow">Derived preview</p>
                <h3>Description</h3>
              </div>
              <div className="task-history-card skills-derived-preview" data-role="skill-description-preview">
                <strong>{localDraftState.descriptionPreview ? "First non-empty paragraph" : "No description available yet"}</strong>
                <p>{localDraftState.descriptionPreview ?? "Add markdown content to preview the derived description that the catalog will store."}</p>
              </div>
            </section>
          </div>
        ) : currentDetail ? (
          currentDetail.sourceKind === "local" ? (
            <div className="workflow-editor-grid" data-role="skill-detail">
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">Local skill</p>
                  <h3>{currentDetail.name}</h3>
                </div>
                <div className="action-cluster action-cluster--wrap">
                  <span className="status-badge status-badge--accent">Local</span>
                  {currentDetail.archived ? <span className="status-badge status-badge--neutral">Archived</span> : <span className={getSkillStatusBadgeClass(currentDetail.status)}>{getSkillStatusLabel(currentDetail.status)}</span>}
                  <button className="secondary-button" data-role={currentDetail.archived ? "unarchive-skill" : "archive-skill"} type="button" onClick={() => void handleArchiveToggle(!currentDetail.archived)} disabled={saving}>
                    {currentDetail.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button className="secondary-button secondary-button--danger" data-role="delete-skill" type="button" onClick={() => void handleDeleteSkill()} disabled={saving}>
                    {deleteConfirmationRequired ? "Confirm delete" : "Delete"}
                  </button>
                  <button className="primary-button" data-role="save-skill" type="button" onClick={() => void handleSaveSkill()} disabled={saving || loadingDetail}>
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>

              {loadingDetail ? <p className="muted-copy">Loading skill…</p> : null}

              <section className="workflow-section skills-form-section">
                <div>
                  <p className="eyebrow">Phase 1 editor</p>
                  <h3>Name and markdown</h3>
                </div>

                <div className="skills-form-grid">
                  <label className="field-group">
                    <span className="field-group__label">Skill name</span>
                    <input className="text-input" data-role="skill-name" type="text" value={localDraft.name} onChange={(event) => setLocalDraft((draft) => ({ ...draft, name: event.target.value }))} />
                    {localDraftState.validationErrors.name ? <span className="field-error">{localDraftState.validationErrors.name}</span> : null}
                  </label>

                  <label className="field-group">
                    <span className="field-group__label">Slug</span>
                    <input className="text-input" data-role="skill-slug" type="text" placeholder="Leave blank to derive from the name" value={localDraft.slug ?? ""} onChange={(event) => setLocalDraft((draft) => ({ ...draft, slug: event.target.value }))} />
                    <span className="field-group__hint">{localDraftState.normalizedSlug ? `Saved as ${localDraftState.normalizedSlug}` : localDraftState.slugPreview ? `Will derive ${localDraftState.slugPreview}` : "A slug will be derived from the skill name."}</span>
                    {localDraftState.validationErrors.slug ? <span className="field-error">{localDraftState.validationErrors.slug}</span> : null}
                  </label>

                  <label className="field-group skills-form-grid__full">
                    <span className="field-group__label">Markdown body</span>
                    <textarea className="text-area skills-markdown-input" data-role="skill-markdown-body" rows={18} value={localDraft.markdownBody} onChange={(event) => setLocalDraft((draft) => ({ ...draft, markdownBody: event.target.value }))} />
                    <span className="field-group__hint">The editor stays phase-1 scoped to name, slug, and markdown content only.</span>
                    {localDraftState.validationErrors.markdownBody ? <span className="field-error">{localDraftState.validationErrors.markdownBody}</span> : null}
                  </label>
                </div>
              </section>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Derived preview</p>
                  <h3>Description</h3>
                </div>
                <div className="task-history-card skills-derived-preview" data-role="skill-description-preview">
                  <strong>{localDraftState.descriptionPreview ? "First non-empty paragraph" : "No description available yet"}</strong>
                  <p>{localDraftState.descriptionPreview ?? "Add markdown content to preview the derived description that the catalog will store."}</p>
                </div>
              </section>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Bindings summary</p>
                  <h3>Current bindings</h3>
                </div>
                {currentDetail.bindingSummary.totalCount > 0 ? (
                  <div className="skills-binding-summary" data-role="skill-bindings-summary">
                    <span className="status-badge status-badge--accent">{currentDetail.bindingSummary.totalCount} binding{currentDetail.bindingSummary.totalCount === 1 ? "" : "s"}</span>
                    {currentDetail.bindingSummary.scopeCounts.map((scopeCount) => (
                      <span className="status-badge status-badge--neutral" key={scopeCount.scopeKind}>
                        {getBindingScopeLabel(scopeCount.scopeKind)} · {scopeCount.count}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy" data-role="skill-bindings-summary">No bindings yet.</p>
                )}
              </section>
            </div>
          ) : (
            <div className="workflow-editor-grid" data-role="skill-detail">
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">External skill</p>
                  <h3>{currentDetail.name}</h3>
                </div>
                <div className="action-cluster action-cluster--wrap">
                  <span className="status-badge status-badge--neutral">External</span>
                  <span className="status-badge status-badge--neutral">Read-only</span>
                  {currentDetail.archived ? <span className="status-badge status-badge--neutral">Archived</span> : <span className={getSkillStatusBadgeClass(currentDetail.status)}>{getSkillStatusLabel(currentDetail.status)}</span>}
                </div>
              </div>

              <div className="skills-warning-stack">
                {detailWarnings.map((warning) => (
                  <div className={`skills-warning skills-warning--${warning.tone}`} key={`${warning.title}-${warning.message}`}>
                    <strong>{warning.title}</strong>
                    <p>{warning.message}</p>
                  </div>
                ))}
              </div>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Source</p>
                  <h3>Discovery paths</h3>
                </div>
                <dl className="skills-path-list">
                  <div>
                    <dt>Relative source</dt>
                    <dd>{currentDetail.relativeSourcePath ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Source path</dt>
                    <dd>{currentDetail.sourcePath}</dd>
                  </div>
                  <div>
                    <dt>Content path</dt>
                    <dd>{currentDetail.contentPath}</dd>
                  </div>
                </dl>
              </section>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">Bindings summary</p>
                  <h3>Current bindings</h3>
                </div>
                {currentDetail.bindingSummary.totalCount > 0 ? (
                  <div className="skills-binding-summary" data-role="skill-bindings-summary">
                    <span className="status-badge status-badge--accent">{currentDetail.bindingSummary.totalCount} binding{currentDetail.bindingSummary.totalCount === 1 ? "" : "s"}</span>
                    {currentDetail.bindingSummary.scopeCounts.map((scopeCount) => (
                      <span className="status-badge status-badge--neutral" key={scopeCount.scopeKind}>
                        {getBindingScopeLabel(scopeCount.scopeKind)} · {scopeCount.count}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="muted-copy" data-role="skill-bindings-summary">No bindings yet.</p>
                )}
              </section>

              <section className="workflow-section">
                <div>
                  <p className="eyebrow">SKILL.md preview</p>
                  <h3>Read-only markdown</h3>
                </div>
                {currentDetail.markdownBody ? (
                  <div className="task-history-card skills-markdown-preview-shell">
                    <MarkdownContent dataRole="skill-markdown-preview" message={currentDetail.markdownBody} />
                  </div>
                ) : (
                  <div className="task-history-card skills-markdown-preview-shell" data-role="skill-markdown-preview-empty">
                    <strong>Markdown preview unavailable</strong>
                    <p>The SKILL.md file is currently unavailable, so Orchestra cannot render a read-only preview.</p>
                  </div>
                )}
              </section>
            </div>
          )
        ) : loadingDetail ? (
          <div className="empty-state" data-role="skill-empty-state">
            <h3>Loading skill</h3>
            <p>Fetching the selected skill details…</p>
          </div>
        ) : (
          <div className="empty-state" data-role="skill-empty-state">
            <h3>Select a skill</h3>
            <p>Browse the catalog on the left to inspect an existing local or external skill, or create a new local skill.</p>
          </div>
        )
      )}
    />
  );
}
