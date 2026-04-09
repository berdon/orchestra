import type { AgentSummary, RepositoryRecord, RoleSummary, TaskScheduleDayOfWeek, TaskScheduleUpsertInput, WorkflowSummary } from "../../types";
import { TaskEditorForm } from "./TaskEditorForm";

const DAY_OPTIONS: Array<{ value: TaskScheduleDayOfWeek; label: string }> = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

const DOMAIN_EVENT_OPTIONS = [
  "task.created",
  "task.updated",
  "task.deleted",
  "task.comment_added",
  "task.comment_updated",
  "task.comment_deleted",
  "task.file_reference_added",
  "task.attachment_added",
  "task.dispatched",
  "task.completed",
  "task.failed",
  "task.user_intervention_requested",
  "session.created",
  "session.resumed",
  "session.closed",
  "session.dismissed",
  "project.updated",
  "repository.created",
  "repository.updated",
  "repository.deleted",
  "agent.created",
  "agent.updated",
  "agent.archived",
  "role.created",
  "role.updated",
  "role.archived",
  "workflow.created",
  "workflow.updated",
  "workflow.archived",
] as const;

interface TaskScheduleEditorFormProps {
  draft: TaskScheduleUpsertInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  detailLayout?: boolean;
  onChange: (nextDraft: TaskScheduleUpsertInput) => void;
}

function triggerSummary(draft: TaskScheduleUpsertInput) {
  if (draft.trigger.type === "event") {
    return "Materialize a task whenever a matching Orchestra domain event arrives.";
  }

  switch (draft.trigger.kind) {
    case "once":
      return "Run the schedule once at an exact date/time.";
    case "everyMinutes":
      return "Run on a simple fixed interval measured in minutes.";
    case "daily":
      return "Run once per day at the selected time.";
    case "weekly":
      return "Run on one or more weekdays at the selected time.";
    case "monthly":
      return "Run once per month on the chosen day and time.";
    default:
      return "";
  }
}

export function TaskScheduleEditorForm({
  draft,
  workflows,
  agents,
  roles,
  repositories,
  detailLayout = false,
  onChange,
}: TaskScheduleEditorFormProps) {
  const trigger = draft.trigger;
  const isSingleFire = trigger.type === "time" && trigger.kind === "once";

  const updateTrigger = (nextTrigger: TaskScheduleUpsertInput["trigger"]) => {
    onChange({ ...draft, trigger: nextTrigger, oneShot: draft.oneShot || (nextTrigger.type === "time" && nextTrigger.kind === "once") });
  };

  return (
    <div className="task-schedule-editor-stack">
      <div className="task-detail-edit-shell__header">
        <div>
          <p className="eyebrow">Task blueprint</p>
          <h3>Scheduled task definition</h3>
          <p className="muted-copy">Saved schedules materialize normal ready tasks using this blueprint whenever the trigger fires.</p>
        </div>
      </div>

      <TaskEditorForm
        agents={agents}
        draft={draft.task}
        onChange={(task) => onChange({ ...draft, task })}
        repositories={repositories}
        roles={roles}
        showStatusField={false}
        workflows={workflows}
        detailLayout={detailLayout}
        showAssigneeFields={false}
      />

      <div className={detailLayout ? "task-editor-grid task-editor-grid--detail" : "task-editor-grid"}>
        <label className="checkbox-field">
          <input
            data-role="task-schedule-enabled"
            type="checkbox"
            checked={draft.enabled ?? true}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span>Schedule enabled</span>
        </label>

        <label className="checkbox-field">
          <input
            data-role="task-schedule-one-shot"
            type="checkbox"
            checked={draft.oneShot || isSingleFire}
            disabled={isSingleFire}
            onChange={(event) => onChange({ ...draft, oneShot: event.target.checked })}
          />
          <span>Disable after the first trigger</span>
        </label>

        <label className="field-group">
          <span className="field-group__label">Overlap policy</span>
          <select
            className="select-input"
            data-role="task-schedule-overlap-policy"
            value={draft.overlapPolicy}
            onChange={(event) => onChange({ ...draft, overlapPolicy: event.target.value as TaskScheduleUpsertInput["overlapPolicy"] })}
          >
            <option value="skip">Skip while another materialized task is still open</option>
            <option value="create_another">Always create another task</option>
          </select>
        </label>

        <label className="field-group">
          <span className="field-group__label">Trigger source</span>
          <select
            className="select-input"
            data-role="task-schedule-trigger-type"
            value={trigger.type}
            onChange={(event) => {
              if (event.target.value === "event") {
                updateTrigger({ type: "event", eventKey: "task.created" });
                return;
              }
              updateTrigger({ type: "time", kind: "daily", timeOfDay: "09:00", timezone: "UTC" });
            }}
          >
            <option value="time">Time</option>
            <option value="event">Event</option>
          </select>
        </label>

        {trigger.type === "time" ? (
          <>
            <label className="field-group">
              <span className="field-group__label">Time trigger</span>
              <select
                className="select-input"
                data-role="task-schedule-trigger-kind"
                value={trigger.kind}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (kind === "once") {
                    updateTrigger({ type: "time", kind: "once", at: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16) + ":00.000Z", timezone: "UTC" });
                  } else if (kind === "everyMinutes") {
                    updateTrigger({ type: "time", kind: "everyMinutes", everyMinutes: 60 });
                  } else if (kind === "daily") {
                    updateTrigger({ type: "time", kind: "daily", timeOfDay: "09:00", timezone: "UTC" });
                  } else if (kind === "weekly") {
                    updateTrigger({ type: "time", kind: "weekly", timeOfDay: "09:00", timezone: "UTC", daysOfWeek: [1] });
                  } else {
                    updateTrigger({ type: "time", kind: "monthly", timeOfDay: "09:00", timezone: "UTC", dayOfMonth: 1 });
                  }
                }}
              >
                <option value="once">Once</option>
                <option value="everyMinutes">Every N minutes</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>

            {trigger.kind === "once" ? (
              <label className="field-group">
                <span className="field-group__label">Run at (UTC)</span>
                <input
                  className="text-input"
                  data-role="task-schedule-trigger-at"
                  type="datetime-local"
                  value={trigger.at.slice(0, 16)}
                  onChange={(event) => updateTrigger({ ...trigger, at: `${event.target.value}:00.000Z` })}
                />
              </label>
            ) : trigger.kind === "everyMinutes" ? (
              <label className="field-group">
                <span className="field-group__label">Every minutes</span>
                <input
                  className="text-input"
                  data-role="task-schedule-trigger-every-minutes"
                  type="number"
                  min={1}
                  value={trigger.everyMinutes}
                  onChange={(event) => updateTrigger({ ...trigger, everyMinutes: Math.max(1, Number(event.target.value || 1)) })}
                />
              </label>
            ) : (
              <label className="field-group">
                <span className="field-group__label">Time of day</span>
                <input
                  className="text-input"
                  data-role="task-schedule-trigger-time-of-day"
                  type="time"
                  value={trigger.timeOfDay}
                  onChange={(event) => updateTrigger({ ...trigger, timeOfDay: event.target.value })}
                />
              </label>
            )}

            {trigger.kind !== "everyMinutes" ? (
              <label className="field-group">
                <span className="field-group__label">Timezone</span>
                <input
                  className="text-input"
                  data-role="task-schedule-trigger-timezone"
                  value={trigger.timezone}
                  onChange={(event) => updateTrigger({ ...trigger, timezone: event.target.value })}
                />
              </label>
            ) : null}

            {trigger.kind === "weekly" ? (
              <div className="field-group task-editor-grid__full">
                <span className="field-group__label">Days of week</span>
                <div className="task-schedule-day-picker" data-role="task-schedule-trigger-days-of-week">
                  {DAY_OPTIONS.map((day) => {
                    const selected = trigger.daysOfWeek.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        className={selected ? "task-schedule-day-pill task-schedule-day-pill--active" : "task-schedule-day-pill"}
                        type="button"
                        onClick={() => updateTrigger({
                          ...trigger,
                          daysOfWeek: selected
                            ? trigger.daysOfWeek.filter((value) => value !== day.value)
                            : [...trigger.daysOfWeek, day.value].sort((left, right) => left - right),
                        })}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {trigger.kind === "monthly" ? (
              <label className="field-group">
                <span className="field-group__label">Day of month</span>
                <input
                  className="text-input"
                  data-role="task-schedule-trigger-day-of-month"
                  type="number"
                  min={1}
                  max={31}
                  value={trigger.dayOfMonth}
                  onChange={(event) => updateTrigger({ ...trigger, dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value || 1))) })}
                />
              </label>
            ) : null}
          </>
        ) : (
          <label className="field-group task-editor-grid__full">
            <span className="field-group__label">Domain event key</span>
            <input
              className="text-input"
              data-role="task-schedule-trigger-event-key"
              list="task-schedule-domain-events"
              value={trigger.eventKey}
              onChange={(event) => updateTrigger({ ...trigger, eventKey: event.target.value })}
            />
            <datalist id="task-schedule-domain-events">
              {DOMAIN_EVENT_OPTIONS.map((eventKey) => (
                <option key={eventKey} value={eventKey} />
              ))}
            </datalist>
          </label>
        )}

        <div className="task-editor-grid__full muted-copy">{triggerSummary(draft)}</div>
      </div>
    </div>
  );
}
