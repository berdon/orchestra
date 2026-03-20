use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    models::{AgentQueueEntry, AgentRuntimeState},
    services::{agent_runtime, agents, live_sessions, pi_sessions},
    state::{generate_id, AppState},
};

pub fn dispatch_all_agent_queues(
    app: AppHandle,
    state: &AppState,
    project_root: &Path,
    session_dir: &Path,
) -> Result<usize, String> {
    let connection = crate::services::database::open_connection()?;
    let runtimes = agent_runtime::list_agent_operations(&connection, false)?;
    drop(connection);

    let mut dispatched = 0;
    for runtime in runtimes {
        dispatched += dispatch_agent_queue(
            app.clone(),
            state,
            project_root,
            session_dir,
            &runtime.agent.id,
        )? as usize;
    }
    Ok(dispatched)
}

pub fn dispatch_agent_queue(
    app: AppHandle,
    state: &AppState,
    project_root: &Path,
    session_dir: &Path,
    agent_id: &str,
) -> Result<bool, String> {
    let connection = crate::services::database::open_connection()?;
    let runtime_state = agent_runtime::ensure_agent_runtime_state(&connection, agent_id)?;
    let queue_entries = agent_runtime::list_agent_queue_entries(&connection, Some(agent_id), false)?;
    drop(connection);

    if queue_entries.is_empty() {
        return Ok(false);
    }

    if let Some(current_queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
        let queue_entries = queue_entries
            .into_iter()
            .filter(|entry| entry.id != current_queue_entry_id)
            .collect::<Vec<_>>();
        let mut delivered = false;
        for entry in queue_entries {
            if entry.delivery_mode == "prompt" {
                continue;
            }
            deliver_nonblocking_entry(app.clone(), state, project_root, session_dir, &runtime_state, &entry)?;
            delivered = true;
        }
        return Ok(delivered);
    }

    let next_entry = queue_entries.into_iter().find(|entry| entry.status == "queued");
    let Some(entry) = next_entry else {
        return Ok(false);
    };

    let runtime_state = ensure_main_session(project_root, session_dir, agent_id)?;
    if entry.delivery_mode == "prompt" {
        deliver_prompt_entry(app, state, session_dir, &runtime_state, &entry)?;
    } else {
        deliver_nonblocking_entry(app, state, project_root, session_dir, &runtime_state, &entry)?;
    }
    Ok(true)
}

pub fn complete_agent_run(
    session_id: &str,
    run_id: Option<&str>,
) -> Result<(), String> {
    let connection = crate::services::database::open_connection()?;
    let Some(agent_id) = agent_for_session(&connection, session_id)? else {
        return Ok(());
    };
    if let Some(runtime_state) = agent_runtime::get_agent_runtime_state(&connection, &agent_id)? {
        if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
            let queue_entry = agent_runtime::get_agent_queue_entry(&connection, queue_entry_id)?;
            if run_id.is_none() || queue_entry.run_id.as_deref() == run_id {
                agent_runtime::mark_agent_queue_entry_completed(&connection, queue_entry_id)?;
                let _ = agent_runtime::update_agent_runtime_dispatch_state(
                    &connection,
                    &agent_id,
                    Some(session_id),
                    runtime_state.runtime_cwd.as_deref(),
                    None,
                    "idle",
                    None,
                )?;
            }
        }
    }
    Ok(())
}

pub fn fail_agent_run(
    session_id: &str,
    run_id: Option<&str>,
    error_message: &str,
) -> Result<(), String> {
    let connection = crate::services::database::open_connection()?;
    let Some(agent_id) = agent_for_session(&connection, session_id)? else {
        return Ok(());
    };
    if let Some(runtime_state) = agent_runtime::get_agent_runtime_state(&connection, &agent_id)? {
        if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
            let queue_entry = agent_runtime::get_agent_queue_entry(&connection, queue_entry_id)?;
            if run_id.is_none() || queue_entry.run_id.as_deref() == run_id {
                agent_runtime::mark_agent_queue_entry_failed(&connection, queue_entry_id)?;
                let _ = agent_runtime::update_agent_runtime_dispatch_state(
                    &connection,
                    &agent_id,
                    Some(session_id),
                    runtime_state.runtime_cwd.as_deref(),
                    None,
                    "needs_attention",
                    Some(error_message),
                )?;
            }
        }
    }
    Ok(())
}

fn deliver_prompt_entry(
    app: AppHandle,
    state: &AppState,
    session_dir: &Path,
    runtime_state: &AgentRuntimeState,
    entry: &AgentQueueEntry,
) -> Result<(), String> {
    let session_id = runtime_state
        .main_session_id
        .as_deref()
        .ok_or_else(|| format!("Agent {} has no main session", runtime_state.agent_id))?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .as_deref()
        .ok_or_else(|| format!("Agent {} has no runtime cwd", runtime_state.agent_id))?;
    let run_id = generate_id("agent-dispatch");
    let connection = crate::services::database::open_connection()?;
    let claimed = agent_runtime::mark_agent_queue_entry_dispatched(&connection, &entry.id, session_id, &run_id)?;
    if claimed.is_none() {
        return Ok(());
    }
    let _ = agent_runtime::update_agent_runtime_dispatch_state(
        &connection,
        &runtime_state.agent_id,
        Some(session_id),
        Some(runtime_cwd),
        Some(&entry.id),
        "running",
        None,
    )?;

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir.to_path_buf(),
        session_id,
    )?;
    runtime.set_subscribed(true);
    state.begin_session_run(session_id, &run_id)?;
    match runtime.start_delivery(&run_id, "prompt", &entry.message) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(session_id, &run_id);
            let _ = agent_runtime::mark_agent_queue_entry_failed(&connection, &entry.id);
            let _ = agent_runtime::update_agent_runtime_dispatch_state(
                &connection,
                &runtime_state.agent_id,
                Some(session_id),
                Some(runtime_cwd),
                None,
                "needs_attention",
                Some(&error),
            );
            Err(error)
        }
    }
}

fn deliver_nonblocking_entry(
    app: AppHandle,
    state: &AppState,
    project_root: &Path,
    session_dir: &Path,
    runtime_state: &AgentRuntimeState,
    entry: &AgentQueueEntry,
) -> Result<(), String> {
    let session_id = runtime_state
        .main_session_id
        .as_deref()
        .ok_or_else(|| format!("Agent {} has no main session", runtime_state.agent_id))?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .as_deref()
        .unwrap_or_else(|| project_root.to_str().unwrap_or("."));
    let run_id = format!("queued-{}", Uuid::new_v4().simple());
    let connection = crate::services::database::open_connection()?;
    let claimed = agent_runtime::mark_agent_queue_entry_dispatched(&connection, &entry.id, session_id, &run_id)?;
    if claimed.is_none() {
        return Ok(());
    }
    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir.to_path_buf(),
        session_id,
    )?;
    match runtime.start_delivery(&run_id, &entry.delivery_mode, &entry.message) {
        Ok(()) => {
            agent_runtime::mark_agent_queue_entry_completed(&connection, &entry.id)?;
            Ok(())
        }
        Err(error) => {
            let _ = agent_runtime::mark_agent_queue_entry_failed(&connection, &entry.id);
            Err(error)
        }
    }
}

pub fn ensure_main_session(
    project_root: &Path,
    session_dir: &Path,
    agent_id: &str,
) -> Result<AgentRuntimeState, String> {
    let connection = crate::services::database::open_connection()?;
    let runtime_state = agent_runtime::ensure_agent_runtime_state(&connection, agent_id)?;
    if let Some(session_id) = runtime_state.main_session_id.as_deref() {
        if pi_sessions::get_session(session_dir, session_id, false).is_ok() {
            return Ok(runtime_state);
        }
    }

    let agent = agents::get_agent(&connection, agent_id)?;
    let runtime_cwd = project_root.display().to_string();
    let created = pi_sessions::create_session_file(
        project_root,
        session_dir,
        Some(&format!("{} main session", agent.name)),
        false,
    )?;
    if let (Some(provider), Some(model)) = (agent.provider.as_deref(), agent.model.as_deref()) {
        let _ = pi_sessions::set_session_model(project_root, session_dir, &created.record.id, provider, model)?;
    }
    let _ = pi_sessions::set_session_thinking_level(project_root, session_dir, &created.record.id, &agent.thinking_level)?;
    agent_runtime::update_agent_runtime_dispatch_state(
        &connection,
        agent_id,
        Some(&created.record.id),
        Some(&runtime_cwd),
        runtime_state.current_queue_entry_id.as_deref(),
        &runtime_state.status,
        runtime_state.last_error.as_deref(),
    )
}

fn agent_for_session(connection: &rusqlite::Connection, session_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT agent_id FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve agent runtime for session {session_id}: {error}"))
}
