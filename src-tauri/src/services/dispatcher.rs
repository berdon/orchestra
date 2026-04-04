use std::{thread, time::Duration};

use tauri::{AppHandle, Manager};

use crate::{
    services::{
        agent_dispatch, app_events, database, pi_sessions, reminders, role_dispatch, role_runtime,
        task_runtime,
    },
    state::AppState,
};

const DISPATCHER_INTERVAL: Duration = Duration::from_secs(3);

pub fn start_dispatcher_loop(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(DISPATCHER_INTERVAL);
        let _ = run_dispatcher_tick(app.clone());
    });
}

pub fn run_dispatcher_tick(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut guard = state
            .dispatcher_tick_active
            .lock()
            .map_err(|_| "Unable to access dispatcher tick state".to_string())?;
        if *guard {
            return Ok(());
        }
        *guard = true;
    }

    let result = run_dispatcher_tick_inner(app.clone(), &state);

    if let Ok(mut guard) = state.dispatcher_tick_active.lock() {
        *guard = false;
    }

    result
}

fn run_dispatcher_tick_inner(app: AppHandle, state: &AppState) -> Result<(), String> {
    state.log(
        "info",
        "dispatcher.tick.started",
        "Starting dispatcher tick",
    );
    let context = pi_sessions::detect_session_context(None)?;

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

    let auto_dispatched_tasks = auto_dispatch_work_ready_tasks(app.clone(), state)?;
    let whip_results = process_task_whips(app.clone(), state)?;
    let reminder_results = reminders::process_due_reminders(app.clone(), state)?;

    state.log(
        "info",
        "dispatcher.tick.completed",
        &format!(
            "Completed dispatcher tick with {} agent dispatches, {} activated role assignments, {} auto-dispatched tasks, {} whip actions, {} reminder actions",
            agent_dispatches, activated_roles, auto_dispatched_tasks, whip_results, reminder_results
        ),
    );
    Ok(())
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
