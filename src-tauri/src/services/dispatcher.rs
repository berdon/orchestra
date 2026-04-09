use std::{thread, time::Duration};

use tauri::{AppHandle, Manager};

use crate::{
    services::{
        agent_dispatch, app_events, database, pi_sessions, reminders, role_dispatch, role_runtime,
        task_runtime, task_schedules,
    },
    state::AppState,
};

const DISPATCHER_MIN_INTERVAL: Duration = Duration::from_secs(5);
const DISPATCHER_MAX_INTERVAL: Duration = Duration::from_secs(60);

pub fn start_dispatcher_loop(app: AppHandle) {
    thread::spawn(move || {
        let mut next_interval = DISPATCHER_MIN_INTERVAL;
        loop {
            thread::sleep(next_interval);
            match run_dispatcher_tick_and_count(app.clone()) {
                Ok(actions) => {
                    next_interval = next_dispatcher_interval(next_interval, actions);
                }
                Err(_) => {
                    next_interval = DISPATCHER_MIN_INTERVAL;
                }
            }
        }
    });
}

pub fn run_dispatcher_tick(app: AppHandle) -> Result<(), String> {
    run_dispatcher_tick_and_count(app).map(|_| ())
}

fn run_dispatcher_tick_and_count(app: AppHandle) -> Result<usize, String> {
    let state = app.state::<AppState>();
    {
        let mut guard = state
            .dispatcher_tick_active
            .lock()
            .map_err(|_| "Unable to access dispatcher tick state".to_string())?;
        if *guard {
            return Ok(0);
        }
        *guard = true;
    }

    let result = run_dispatcher_tick_inner(app.clone(), &state);

    if let Ok(mut guard) = state.dispatcher_tick_active.lock() {
        *guard = false;
    }

    result
}

fn run_dispatcher_tick_inner(app: AppHandle, state: &AppState) -> Result<usize, String> {
    if state.sync_pi_runtime_health().is_err() {
        return Ok(0);
    }

    state.log(
        "info",
        "dispatcher.tick.started",
        "Starting dispatcher tick",
    );
    let context = pi_sessions::detect_session_context(None)?;

    let stale_assignment_recoveries = recover_stale_task_assignments(app.clone(), state)?;

    let agent_dispatches = agent_dispatch::dispatch_all_agent_queues(
        app.clone(),
        state,
        &context.project_root,
        &context.session_dir,
    )?;

    let connection = database::open_connection()?;
    let queued_roles = role_runtime::list_role_operations(&connection, false)?
        .into_iter()
        .filter(|snapshot| snapshot.queued_count > 0)
        .map(|snapshot| snapshot.role.id)
        .collect::<Vec<_>>();
    drop(connection);

    let mut activated_roles = 0;
    for role_id in queued_roles {
        let mut connection = database::open_connection()?;
        let _ = role_dispatch::dispatch_role_queue(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &role_id,
        )?;
        let activated = task_runtime::activate_queued_role_assignments(&connection)?;
        for assignment in activated {
            let assignment_session_dir = if let Some(session_id) = assignment.session_id.as_deref()
            {
                pi_sessions::find_session_context_for_session(session_id)
                    .map(|resolved| resolved.session_dir)
                    .unwrap_or_else(|_| context.session_dir.clone())
            } else {
                context.session_dir.clone()
            };
            task_runtime::start_assignment_run(
                app.clone(),
                state,
                assignment_session_dir,
                &assignment,
            )?;
            if let Some(session_id) = assignment.session_id.clone() {
                let _ = app_events::emit_session_change(
                    &app,
                    "task.runtime.assignment_started",
                    [session_id],
                );
            }
            let _ = app_events::emit_task_change(
                &app,
                "task.runtime.assignment_started",
                [assignment.task_id.clone()],
            );
            activated_roles += 1;
        }
    }

    let schedule_results = process_task_schedules(app.clone())?;
    let auto_dispatched_tasks = auto_dispatch_work_ready_tasks(app.clone(), state)?;
    let whip_results = process_task_whips(app.clone(), state)?;
    let reminder_results = reminders::process_due_reminders(app.clone(), state)?;

    let total_actions = stale_assignment_recoveries
        + agent_dispatches
        + activated_roles
        + schedule_results
        + auto_dispatched_tasks
        + whip_results
        + reminder_results;

    state.log(
        "info",
        "dispatcher.tick.completed",
        &format!(
            "Completed dispatcher tick with {} stale assignment recoveries, {} agent dispatches, {} activated role assignments, {} schedule actions, {} auto-dispatched tasks, {} whip actions, {} reminder actions ({} total actions)",
            stale_assignment_recoveries, agent_dispatches, activated_roles, schedule_results, auto_dispatched_tasks, whip_results, reminder_results, total_actions
        ),
    );
    Ok(total_actions)
}

fn next_dispatcher_interval(current: Duration, actions: usize) -> Duration {
    if actions > 0 {
        return DISPATCHER_MIN_INTERVAL;
    }

    let doubled = current.as_secs().saturating_mul(2);
    Duration::from_secs(doubled.clamp(
        DISPATCHER_MIN_INTERVAL.as_secs(),
        DISPATCHER_MAX_INTERVAL.as_secs(),
    ))
}

fn recover_stale_task_assignments(app: AppHandle, state: &AppState) -> Result<usize, String> {
    let connection = database::open_connection()?;
    let candidates = task_runtime::find_stale_task_assignment_candidates(&connection)?;
    drop(connection);

    let mut recovered = 0;
    for candidate in candidates {
        let mut connection = database::open_connection()?;
        let Some(current_assignment) =
            task_runtime::get_assignment_by_id(&connection, &candidate.assignment_id)?
        else {
            continue;
        };
        if current_assignment.status != "active" && current_assignment.status != "queued" {
            continue;
        }

        let task = task_runtime::reset_task_runtime(&mut connection, &candidate.task_id)?;
        state.log(
            "warn",
            "task.runtime.stale_assignment_recovered",
            &format!(
                "Recovered stale assignment {} for task {}: {}",
                candidate.assignment_id, candidate.task_id, candidate.reason
            ),
        );
        let _ = app_events::emit_task_change(
            &app,
            "task.runtime.stale_assignment_recovered",
            [task.id.clone()],
        );
        if let Some(session_id) = candidate.session_id.clone() {
            let _ = app_events::emit_session_change(
                &app,
                "task.runtime.stale_assignment_recovered",
                [session_id.clone()],
            );
            crate::services::live_sessions::schedule_session_retirement(
                app.clone(),
                session_id,
                Duration::ZERO,
                "task.runtime.stale_assignment_recovered",
            );
        }

        let candidate_context = pi_sessions::session_context_for_project_id(&candidate.project_id)?;
        if let Some(assignment) = task_runtime::maybe_auto_dispatch_task(
            &mut connection,
            &candidate_context.project_root,
            &candidate_context.session_dir,
            &candidate.task_id,
        )? {
            task_runtime::start_assignment_run(
                app.clone(),
                state,
                candidate_context.session_dir.clone(),
                &assignment,
            )?;
            if let Some(session_id) = assignment.session_id.clone() {
                let _ = app_events::emit_session_change(
                    &app,
                    "task.runtime.assignment_restarted",
                    [session_id],
                );
            }
            let _ = app_events::emit_task_change(
                &app,
                "task.runtime.assignment_restarted",
                [assignment.task_id.clone()],
            );
        }
        recovered += 1;
    }

    Ok(recovered)
}

fn process_task_schedules(app: AppHandle) -> Result<usize, String> {
    let mut connection = database::open_connection()?;
    let result = task_schedules::process_due_task_schedules(&mut connection)?;
    for task_id in &result.materialized_task_ids {
        let _ = app_events::emit_task_change(&app, "task.schedule.materialized", [task_id.clone()]);
    }
    if !result.touched_schedule_ids.is_empty() {
        let _ = app_events::emit_task_change(&app, "task.schedule.updated", Vec::<String>::new());
    }
    Ok(result.materialized_task_ids.len())
}

fn auto_dispatch_work_ready_tasks(app: AppHandle, state: &AppState) -> Result<usize, String> {
    let connection = database::open_connection()?;
    let projects = crate::services::projects::list_projects(&connection)?;
    drop(connection);

    let mut dispatched = 0;
    for project in projects {
        let automation =
            crate::services::project_settings::get_task_automation_settings(&project.slug)?;
        if !automation.auto_dispatch_on_blocker_completion {
            continue;
        }

        let mut connection = database::open_connection()?;
        let tasks = crate::services::tasks::list_tasks(&connection, &project.id, false)?;
        let context = pi_sessions::session_context_for_project_id(&project.id)?;
        for task in tasks {
            if !task.ready_for_dispatch {
                continue;
            }

            if let Some(assignment) = task_runtime::maybe_auto_dispatch_task(
                &mut connection,
                &context.project_root,
                &context.session_dir,
                &task.id,
            )? {
                task_runtime::start_assignment_run(
                    app.clone(),
                    state,
                    context.session_dir.clone(),
                    &assignment,
                )?;
                if let Some(session_id) = assignment.session_id.clone() {
                    let _ = app_events::emit_session_change(
                        &app,
                        "task.runtime.auto_dispatch",
                        [session_id],
                    );
                }
                let _ = app_events::emit_task_change(
                    &app,
                    "task.runtime.auto_dispatch",
                    [assignment.task_id.clone()],
                );
                dispatched += 1;
            }
        }
    }

    Ok(dispatched)
}

fn process_task_whips(app: AppHandle, state: &AppState) -> Result<usize, String> {
    let connection = database::open_connection()?;
    let candidates = task_runtime::find_task_whip_candidates(&connection)?;
    drop(connection);

    let mut actions = 0;
    for candidate in candidates {
        let context = pi_sessions::session_context_for_project_id(&candidate.project_id)?;
        let mut connection = database::open_connection()?;
        let Some(candidate) =
            task_runtime::refresh_task_whip_candidate(&connection, &candidate.assignment_id)?
        else {
            state.log(
                "info",
                "task.whip.skipped",
                &format!(
                    "Skipped whip for task {} because assignment {} is no longer eligible",
                    candidate.task_id, candidate.assignment_id
                ),
            );
            continue;
        };

        if state.is_session_running(&candidate.session_id)? {
            state.log(
                "info",
                "task.whip.skipped",
                &format!(
                    "Skipped whip for task {} because session {} is still actively running",
                    candidate.task_id, candidate.session_id
                ),
            );
            continue;
        }

        if candidate.whip_count >= candidate.whip_max_attempts {
            let task = task_runtime::escalate_task_whip_limit_exceeded(
                &mut connection,
                &context.project_root,
                &context.session_dir,
                &candidate,
            )?;
            state.log(
                "warn",
                "task.whip.escalated",
                &format!(
                    "Escalated task {} after {} whip attempts",
                    candidate.task_id, candidate.whip_count
                ),
            );
            let _ = app_events::emit_task_change(&app, "task.whip.escalated", [task.id.clone()]);
            let _ = app_events::emit_session_change(
                &app,
                "task.whip.escalated",
                [candidate.session_id.clone()],
            );
            actions += 1;
            continue;
        }

        if candidate.worker_type == "agent" {
            let _ = task_runtime::send_task_whip(&connection, &candidate)?;
            let _ = agent_dispatch::dispatch_agent_queue(
                app.clone(),
                state,
                &context.project_root,
                &context.session_dir,
                &candidate.project_id,
                &candidate.worker_id,
            )?;
        } else {
            let role_instance_id = candidate.role_instance_id.as_deref().ok_or_else(|| {
                format!(
                    "Role whip candidate {} is missing a role instance",
                    candidate.assignment_id
                )
            })?;
            let runtime_cwd = candidate.runtime_cwd.as_deref().ok_or_else(|| {
                format!(
                    "Role whip candidate {} is missing a runtime cwd",
                    candidate.assignment_id
                )
            })?;
            role_dispatch::mark_role_instance_running(&connection, role_instance_id)?;
            let runtime = crate::services::live_sessions::ensure_runtime(
                &state.session_runtimes,
                app.clone(),
                std::path::PathBuf::from(runtime_cwd),
                context.session_dir.clone(),
                &candidate.session_id,
            )?;
            runtime.set_subscribed(true);
            let run_id = crate::state::generate_id("task-whip-run");
            state.begin_session_run(&candidate.session_id, &run_id)?;
            match runtime.start_run(
                &run_id,
                &task_runtime::build_task_whip_message(&candidate.task_id),
            ) {
                Ok(()) => {
                    task_runtime::record_task_whip_sent(
                        &connection,
                        &candidate.assignment_id,
                        candidate.whip_count,
                    )?;
                }
                Err(error) => {
                    let _ = state.end_session_run(&candidate.session_id, &run_id);
                    let _ = role_dispatch::fail_role_run(&candidate.session_id, &error);
                    return Err(error);
                }
            }
        }
        state.log(
            "info",
            "task.whip.sent",
            &format!(
                "Sent whip {} of {} for task {}",
                candidate.whip_count + 1,
                candidate.whip_max_attempts,
                candidate.task_id
            ),
        );
        let _ = app_events::emit_task_change(&app, "task.whip.sent", [candidate.task_id.clone()]);
        let _ =
            app_events::emit_session_change(&app, "task.whip.sent", [candidate.session_id.clone()]);
        actions += 1;
    }

    Ok(actions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatcher_interval_resets_when_work_happens() {
        assert_eq!(
            next_dispatcher_interval(Duration::from_secs(40), 1),
            DISPATCHER_MIN_INTERVAL
        );
    }

    #[test]
    fn dispatcher_interval_exponentially_backs_off_when_idle() {
        assert_eq!(
            next_dispatcher_interval(DISPATCHER_MIN_INTERVAL, 0),
            Duration::from_secs(10)
        );
        assert_eq!(
            next_dispatcher_interval(Duration::from_secs(10), 0),
            Duration::from_secs(20)
        );
        assert_eq!(
            next_dispatcher_interval(Duration::from_secs(20), 0),
            Duration::from_secs(40)
        );
    }

    #[test]
    fn dispatcher_interval_caps_at_sixty_seconds() {
        assert_eq!(
            next_dispatcher_interval(Duration::from_secs(40), 0),
            DISPATCHER_MAX_INTERVAL
        );
        assert_eq!(
            next_dispatcher_interval(DISPATCHER_MAX_INTERVAL, 0),
            DISPATCHER_MAX_INTERVAL
        );
    }
}
