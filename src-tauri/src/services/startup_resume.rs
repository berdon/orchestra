use std::thread;

use tauri::{AppHandle, Manager};

use crate::{
    services::{app_events, database, pi_sessions, task_runtime},
    state::AppState,
};

pub fn resume_active_session_work_on_startup(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        if let Err(error) = run_resume_active_session_work_on_startup(app.clone(), &state) {
            state.log(
                "error",
                "startup.resume.failed",
                &format!("Unable to resume active session work on startup: {error}"),
            );
        }
    });
}

fn run_resume_active_session_work_on_startup(
    app: AppHandle,
    state: &AppState,
) -> Result<usize, String> {
    if let Err(error) = state.sync_pi_runtime_health() {
        state.log(
            "warn",
            "startup.resume.skipped",
            &format!("Skipping startup resume because PI is unavailable: {error}"),
        );
        return Ok(0);
    }

    let connection = database::open_connection()?;
    let candidates = task_runtime::list_restart_resume_candidates(&connection)?;
    drop(connection);

    let mut resumed = 0;
    for candidate in candidates {
        let connection = database::open_connection()?;
        let Some(assignment) = task_runtime::get_assignment_by_id(&connection, &candidate.assignment_id)? else {
            continue;
        };
        if assignment.status != "active" {
            continue;
        }
        if assignment.session_id.as_deref() != Some(candidate.session_id.as_str()) {
            continue;
        }

        let message = task_runtime::build_restart_resume_message(&connection, &assignment)?;
        let context = pi_sessions::session_context_for_project_id(&candidate.project_id)?;

        match task_runtime::start_assignment_follow_up(
            app.clone(),
            state,
            context.session_dir.clone(),
            &assignment,
            &message,
        ) {
            Ok(()) => {
                state.log(
                    "info",
                    "startup.resume.assignment",
                    &format!(
                        "Resumed active assignment {} for task {} on startup",
                        assignment.id, candidate.task_id
                    ),
                );
                let _ = app_events::emit_task_change(
                    &app,
                    "startup.resume.assignment",
                    [assignment.task_id.clone()],
                );
                if let Some(session_id) = assignment.session_id.clone() {
                    let _ = app_events::emit_session_change(
                        &app,
                        "startup.resume.assignment",
                        [session_id],
                    );
                }
                resumed += 1;
            }
            Err(error) => {
                state.log(
                    "error",
                    "startup.resume.assignment_failed",
                    &format!(
                        "Unable to resume assignment {} for task {} on startup: {}",
                        assignment.id, candidate.task_id, error
                    ),
                );
            }
        }
    }

    if resumed > 0 {
        state.log(
            "info",
            "startup.resume.completed",
            &format!("Resumed {} active task session(s) on startup", resumed),
        );
    }

    Ok(resumed)
}
