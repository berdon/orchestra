use std::{thread, time::Duration};

use tauri::{AppHandle, Manager};

use crate::{services::{agent_dispatch, app_events, database, pi_sessions, role_dispatch, role_runtime, task_runtime}, state::AppState};

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
    state.log("info", "dispatcher.tick.started", "Starting dispatcher tick");
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
            task_runtime::start_assignment_run(
                app.clone(),
                state,
                context.session_dir.clone(),
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

    state.log(
        "info",
        "dispatcher.tick.completed",
        &format!(
            "Completed dispatcher tick with {} agent dispatches and {} activated role assignments",
            agent_dispatches, activated_roles
        ),
    );
    Ok(())
}
