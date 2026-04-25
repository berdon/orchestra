import type { AgentSummary, RoleSummary, TaskScheduleSummary, TaskSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskBoardModel } from "./taskBoardModel";
import { resolveTaskAssigneeLabel } from "./taskBoardModel";
import {
  DEFAULT_TASK_OVERVIEW_STATE,
  TASK_OVERVIEW_SORT_DIRECTION_OPTIONS,
  TASK_OVERVIEW_SORT_FIELD_OPTIONS,
  type TaskOverviewState,
} from "./taskOverviewState";
import { WorkflowTaskBoardSection } from "./WorkflowTaskBoardSection";

interface TasksOverviewPageProps {
  board: TaskBoardModel;
  tagScopedTasks: TaskSummary[];
  availableTags: string[];
  attentionTasks: TaskSummary[];
  schedules: TaskScheduleSummary[];
  overviewState: TaskOverviewState;
  onOverviewStateChange: (nextState: TaskOverviewState | ((current: TaskOverviewState) => TaskOverviewState)) => void;
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenTask: (taskId: string) => void;
  onOpenSchedule: (scheduleId: string) => void;
  onOpenTag: (tag: string) => void;
}

function formatScheduleTrigger(schedule: TaskScheduleSummary) {
  const trigger = schedule.trigger;
  if (trigger.type === "event") {
    return `Event · ${trigger.eventKey}`;
  }
  switch (trigger.kind) {
    case "once":
      return `Once · ${trigger.at}`;
    case "everyMinutes":
      return `Every ${trigger.everyMinutes}m`;
    case "daily":
      return `Daily · ${trigger.timeOfDay}`;
    case "weekly":
      return `Weekly · ${trigger.timeOfDay}`;
    case "monthly":
      return `Monthly · day ${trigger.dayOfMonth}`;
    default:
      return "";
  }
}

function formatSelectedTagsSummary(tags: string[]) {
  const visibleTags = tags.slice(0, 2).map((tag) => `#${tag}`);
  const remainingTagCount = tags.length - visibleTags.length;
  return remainingTagCount > 0
    ? `${visibleTags.join(", ")} +${remainingTagCount}`
    : visibleTags.join(", ");
}

function formatSortSummary(sort: TaskOverviewState["sort"]) {
  const fieldLabel = TASK_OVERVIEW_SORT_FIELD_OPTIONS.find((option) => option.value === sort.field)?.label ?? sort.field;
  const directionLabel = TASK_OVERVIEW_SORT_DIRECTION_OPTIONS.find((option) => option.value === sort.direction)?.label ?? sort.direction;
  return `${fieldLabel} · ${directionLabel}`;
}

export function TasksOverviewPage({
  board,
  tagScopedTasks,
  availableTags,
  attentionTasks,
  schedules,
  overviewState,
  onOverviewStateChange,
  agents,
  roles,
  onOpenTask,
  onOpenSchedule,
  onOpenTag,
}: TasksOverviewPageProps) {
  const filterCounts = {
    all: tagScopedTasks.length,
    attention: attentionTasks.length,
    review: tagScopedTasks.filter((task) => task.status === "in_review").length,
    blocked: tagScopedTasks.filter((task) => task.status === "blocked" || task.dependencyBlocked).length,
    active: tagScopedTasks.filter((task) => task.status === "in_progress" || task.readyForDispatch).length,
    done: tagScopedTasks.filter((task) => task.status === "completed" || task.status === "canceled").length,
    epics: tagScopedTasks.filter((task) => task.type === "epic").length,
  };
  const boardFilterOptions = [
    ["all", "All", filterCounts.all],
    ["attention", "Attention", filterCounts.attention],
    ["review", "Needs review", filterCounts.review],
    ["blocked", "Blocked", filterCounts.blocked],
    ["active", "Active", filterCounts.active],
    ["done", "Done", filterCounts.done],
    ["epics", "Epics", filterCounts.epics],
  ] as Array<[TaskOverviewState["boardFilter"], string, number]>;

  const canToggleTagMatch = overviewState.tags.length > 1;
  const availableTagSet = new Set(availableTags);
  const visibleTags = Array.from(new Set([...availableTags, ...overviewState.tags])).sort((left, right) => left.localeCompare(right));
  const unavailableSelectedTags = overviewState.tags.filter((tag) => !availableTagSet.has(tag));
  const sortUsesDefault = overviewState.sort.field === DEFAULT_TASK_OVERVIEW_STATE.sort.field
    && overviewState.sort.direction === DEFAULT_TASK_OVERVIEW_STATE.sort.direction;
  const filterSummaryItems = [
    overviewState.tags.length
      ? `Tags: ${formatSelectedTagsSummary(overviewState.tags)}${overviewState.tags.length > 1 ? ` · match ${overviewState.tagMatch}` : ""}`
      : null,
    sortUsesDefault ? null : `Sort: ${formatSortSummary(overviewState.sort)}`,
  ].filter((item): item is string => Boolean(item));
  const activeFilterCount = filterSummaryItems.length;

  function updateOverviewState(nextState: TaskOverviewState | ((current: TaskOverviewState) => TaskOverviewState)) {
    onOverviewStateChange(nextState);
  }

  return (
    <section className="tasks-overview-page">
      <section className="tasks-overview-stack">
        <div className="task-overview-controls">
          <div className="task-nav-filters task-nav-filters--horizontal" data-role="task-nav-filters">
            {boardFilterOptions.map(([key, label, count]) => (
              <button
                key={key}
                className={overviewState.boardFilter === key ? "task-nav-filter task-nav-filter--active" : "task-nav-filter"}
                data-role={`task-filter-${key}`}
                type="button"
                onClick={() => updateOverviewState((current) => ({ ...current, boardFilter: key }))}
              >
                <span>{label}</span>
                <span>{count}</span>
              </button>
            ))}
          </div>

          <label className="task-overview-controls__mobile-filter">
            <span className="task-overview-controls__mobile-filter-label">Filter</span>
            <select
              className="select-input task-overview-controls__mobile-filter-select"
              data-role="task-filter-select-mobile"
              value={overviewState.boardFilter}
              onChange={(event) => updateOverviewState((current) => ({
                ...current,
                boardFilter: event.target.value as TaskOverviewState["boardFilter"],
              }))}
            >
              {boardFilterOptions.map(([key, label, count]) => (
                <option key={key} value={key}>{label} ({count})</option>
              ))}
            </select>
          </label>

          <div className="task-view-toggle" data-role="task-view-toggle">
            <button
              className={overviewState.viewMode === "cards" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
              data-role="task-view-cards"
              type="button"
              aria-pressed={overviewState.viewMode === "cards"}
              onClick={() => updateOverviewState((current) => ({ ...current, viewMode: "cards" }))}
            >
              <span aria-hidden="true">▥</span>
              <span>Cards</span>
            </button>
            <button
              className={overviewState.viewMode === "table" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
              data-role="task-view-table"
              type="button"
              aria-pressed={overviewState.viewMode === "table"}
              onClick={() => updateOverviewState((current) => ({ ...current, viewMode: "table" }))}
            >
              <span aria-hidden="true">☰</span>
              <span>Table</span>
            </button>
          </div>
        </div>

        <section
          className={overviewState.filtersExpanded ? "task-overview-filters task-overview-filters--expanded" : "task-overview-filters"}
          data-role="task-overview-filters-card"
          data-expanded={overviewState.filtersExpanded ? "true" : "false"}
        >
          <button
            className="task-overview-filters__toggle"
            data-role="task-overview-filters-toggle"
            type="button"
            aria-expanded={overviewState.filtersExpanded}
            onClick={() => updateOverviewState((current) => ({ ...current, filtersExpanded: !current.filtersExpanded }))}
          >
            <span className="task-overview-filters__toggle-main">
              <span className="task-overview-filters__label-row">
                <strong className="task-overview-filters__label">Filters</strong>
                {activeFilterCount ? (
                  <span className="task-overview-filters__active-count" data-role="task-overview-filters-active-count">
                    {activeFilterCount} active
                  </span>
                ) : null}
              </span>
              <span className="task-overview-filters__summary" data-role="task-overview-filters-summary">
                {filterSummaryItems.length ? filterSummaryItems.map((item) => (
                  <span key={item} className="task-overview-filters__summary-item">{item}</span>
                )) : <span className="task-overview-filters__summary-item task-overview-filters__summary-item--empty">No active filters</span>}
              </span>
            </span>
            <span className="task-overview-filters__indicator" aria-hidden="true">{overviewState.filtersExpanded ? "▾" : "▸"}</span>
          </button>

          {overviewState.filtersExpanded ? (
            <div className="task-overview-filters__body" data-role="task-overview-filters-body">
              <div className="task-overview-toolbar" data-role="task-overview-toolbar">
                {visibleTags.length ? (
                  <div className="task-overview-toolbar__group task-overview-toolbar__group--grow">
                    <div className="task-overview-toolbar__group-header">
                      <div>
                        <p className="eyebrow">Exact tags</p>
                        <h3>Filter by tags</h3>
                      </div>
                      <button
                        className="secondary-button task-overview-toolbar__clear"
                        data-role="task-clear-tags"
                        type="button"
                        disabled={overviewState.tags.length === 0}
                        onClick={() => updateOverviewState((current) => ({ ...current, tags: [] }))}
                      >
                        Clear tags
                      </button>
                    </div>
                    {unavailableSelectedTags.length ? (
                      <p className="muted-copy" data-role="task-tag-filter-note">
                        Saved tag filters for {unavailableSelectedTags.map((tag) => `#${tag}`).join(", ")} no longer match any current task tags. Clear or deselect them to show all work.
                      </p>
                    ) : null}
                    <div className="filter-chip-row" data-role="task-tag-filters">
                      {visibleTags.map((tag) => {
                        const selected = overviewState.tags.includes(tag);
                        return (
                          <button
                            className={selected ? "filter-chip filter-chip--active" : "filter-chip"}
                            data-role="task-tag-filter-chip"
                            data-tag={tag}
                            key={tag}
                            type="button"
                            onClick={() => updateOverviewState((current) => ({
                              ...current,
                              tags: current.tags.includes(tag)
                                ? current.tags.filter((entry) => entry !== tag)
                                : [...current.tags, tag].sort((left, right) => left.localeCompare(right)),
                            }))}
                          >
                            #{tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {visibleTags.length ? (
                  <div className="task-overview-toolbar__group">
                    <span className="task-overview-toolbar__label">Match</span>
                    <div className="task-match-toggle" data-role="task-tag-match-toggle">
                      <button
                        className={overviewState.tagMatch === "any" ? "task-match-toggle__button task-match-toggle__button--active" : "task-match-toggle__button"}
                        data-role="task-tag-match-any"
                        type="button"
                        aria-pressed={overviewState.tagMatch === "any"}
                        disabled={!canToggleTagMatch}
                        onClick={() => updateOverviewState((current) => ({ ...current, tagMatch: "any" }))}
                      >
                        Match any
                      </button>
                      <button
                        className={overviewState.tagMatch === "all" ? "task-match-toggle__button task-match-toggle__button--active" : "task-match-toggle__button"}
                        data-role="task-tag-match-all"
                        type="button"
                        aria-pressed={overviewState.tagMatch === "all"}
                        disabled={!canToggleTagMatch}
                        onClick={() => updateOverviewState((current) => ({ ...current, tagMatch: "all" }))}
                      >
                        Match all
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="task-overview-toolbar__group">
                  <span className="task-overview-toolbar__label">Sort</span>
                  <div className="task-overview-toolbar__sort-fields">
                    <label className="task-overview-toolbar__field">
                      <span className="task-overview-toolbar__field-label">Field</span>
                      <select
                        className="select-input"
                        data-role="task-sort-field"
                        value={overviewState.sort.field}
                        onChange={(event) => updateOverviewState((current) => ({
                          ...current,
                          sort: { ...current.sort, field: event.target.value as TaskOverviewState["sort"]["field"] },
                        }))}
                      >
                        {TASK_OVERVIEW_SORT_FIELD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="task-overview-toolbar__field">
                      <span className="task-overview-toolbar__field-label">Direction</span>
                      <select
                        className="select-input"
                        data-role="task-sort-direction"
                        value={overviewState.sort.direction}
                        onChange={(event) => updateOverviewState((current) => ({
                          ...current,
                          sort: { ...current.sort, direction: event.target.value as TaskOverviewState["sort"]["direction"] },
                        }))}
                      >
                        {TASK_OVERVIEW_SORT_DIRECTION_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        {schedules.length ? (
          <section className="task-board-section" data-role="task-schedule-section">
            <div className="task-board-section__header">
              <div>
                <p className="eyebrow">Automation</p>
                <h3>Scheduled tasks</h3>
              </div>
              <span className="status-badge status-badge--neutral">{schedules.length}</span>
            </div>
            <div className="task-draft-grid" data-role="task-schedule-grid">
              {schedules.map((schedule) => (
                <button key={schedule.id} className="task-list-link task-overview-card task-overview-card--schedule" data-role="task-schedule-card" type="button" onClick={() => onOpenSchedule(schedule.id)}>
                  <div className="task-compact-card__header">
                    <span className="task-list-link__eyebrow">{formatScheduleTrigger(schedule)}</span>
                    <span className={`status-badge status-badge--${schedule.enabled ? "success" : "neutral"}`}>
                      {schedule.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <strong className="task-compact-card__title">{schedule.title}</strong>
                  <div className="task-list-link__meta">
                    <span>{schedule.oneShot ? "one-shot" : "repeating"}</span>
                    <span>{schedule.openMaterializedTaskCount} open</span>
                    <span>{schedule.materializedTaskCount} total</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {board.draftTasks.length ? (
          <section className="task-board-section" data-role="draft-task-section">
            <div className="task-board-section__header">
              <div>
                <p className="eyebrow">Draft work</p>
                <h3>Drafts</h3>
              </div>
              <span className="status-badge status-badge--neutral">{board.draftTasks.length}</span>
            </div>
            <div className="task-draft-grid">
              {board.draftTasks.map((task) => (
                <TaskCompactCard
                  assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                  key={task.id}
                  task={task}
                  onOpen={onOpenTask}
                  onOpenTag={onOpenTag}
                />
              ))}
            </div>
          </section>
        ) : null}

        {attentionTasks.length ? (
          <section className="task-board-section task-section--compact task-attention-queue" data-role="task-attention-section">
            <div className="task-board-section__header">
              <div>
                <p className="eyebrow">Inbox</p>
                <h3>Needs attention</h3>
              </div>
            </div>
            <div className="task-draft-grid" data-role="task-attention-queue">
              {attentionTasks.slice(0, 6).map((task) => (
                <TaskCompactCard
                  assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                  key={task.id}
                  task={task}
                  onOpen={onOpenTask}
                  onOpenTag={onOpenTag}
                />
              ))}
            </div>
          </section>
        ) : null}

        {board.workflowSections.map((section) => (
          <WorkflowTaskBoardSection
            agents={agents}
            displayMode={overviewState.viewMode}
            key={section.workflowId}
            onOpenTask={onOpenTask}
            onOpenTag={onOpenTag}
            roles={roles}
            section={section}
            showDoneTasks={overviewState.boardFilter === "done"}
          />
        ))}
      </section>
    </section>
  );
}
