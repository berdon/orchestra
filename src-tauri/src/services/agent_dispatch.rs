use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    models::{AgentDefinition, AgentQueueEntry, AgentRuntimeState},
    services::{
        agent_runtime, agents, live_sessions, messages, pi_sessions, projects, roles,
        session_records,
    },
    state::{generate_id, AppState},
};

pub fn build_direct_agent_session_context(
    connection: &rusqlite::Connection,
    agent: &AgentDefinition,
    active_project_id: Option<&str>,
) -> Result<String, String> {
    let mut sections = vec![
        format!("You are {} ({}) inside Orchestra.", agent.name, agent.slug),
        "This is your direct agent chat session. There is no active task assignment unless the user explicitly provides one or asks you to fetch one.".to_string(),
    ];

    if let Some(description) = agent
        .description
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Agent description:\n{}", description.trim()));
    }

    if let Some(project_id) = active_project_id {
        let project = projects::get_project(connection, project_id)?;
        sections.push(format!(
            "Current Orchestra project context: {} ({}, id={}). Use this as the default projectId for project-scoped Orchestra tool calls unless the user explicitly asks for a different project.",
            project.name,
            project.slug,
            project.id,
        ));
    }

    if let Some(role_id) = agent.role_id.as_deref() {
        let role = roles::get_role(connection, role_id)?;
        sections.push(format!("Assigned role: {} ({})", role.name, role.slug));
        if let Some(role_prompt) = role
            .system_prompt
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            sections.push(format!("Role prompt:\n{}", role_prompt.trim()));
        }
    }

    if let Some(system_prompt) = agent
        .system_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Agent prompt:\n{}", system_prompt.trim()));
    }

    if !agent.direct_permissions.is_empty() {
        sections.push(format!(
            "Direct Orchestra permissions: {}",
            agent.direct_permissions.join(", ")
        ));
    }

    Ok(sections.join("\n\n"))
}

pub fn seed_direct_agent_session_context(
    connection: &rusqlite::Connection,
    session_dir: &Path,
    session_id: &str,
    agent: &AgentDefinition,
    active_project_id: Option<&str>,
) -> Result<(), String> {
    let context = build_direct_agent_session_context(connection, agent, active_project_id)?;
    pi_sessions::append_session_system_message(session_dir, session_id, &context)?;
    pi_sessions::append_session_assistant_message(
        session_dir,
        session_id,
        &format!(
            "[DEBUG seeded direct agent context for validation — this will be hidden again later]\n\n{}",
            context,
        ),
    )
}

pub fn dispatch_all_agent_queues(
    app: AppHandle,
    state: &AppState,
    _project_root: &Path,
    _session_dir: &Path,
) -> Result<usize, String> {
    let connection = crate::services::database::open_connection()?;
    let targets = agent_runtime::list_agent_queue_targets(&connection)?;
    drop(connection);

    let mut dispatched = 0;
    for (project_id, agent_id) in targets {
        let context = pi_sessions::session_context_for_project_id(&project_id)?;
        dispatched += dispatch_agent_queue(
            app.clone(),
            state,
            &context.project_root,
            &context.session_dir,
            &project_id,
            &agent_id,
        )? as usize;
    }
    Ok(dispatched)
}

pub fn dispatch_agent_queue(
    app: AppHandle,
    state: &AppState,
    project_root: &Path,
    session_dir: &Path,
    project_id: &str,
    agent_id: &str,
) -> Result<bool, String> {
    let connection = crate::services::database::open_connection()?;
    let runtime_state =
        agent_runtime::ensure_agent_runtime_state_for_project(&connection, project_id, agent_id)?;
    let queue_entries = agent_runtime::list_agent_queue_entries_for_project(
        &connection,
        project_id,
        Some(agent_id),
        false,
    )?;

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
            if !agent_runtime::queue_entry_is_valid(&connection, &entry)? {
                let _ = agent_runtime::cancel_agent_queue_entry(&connection, &entry.id)?;
                continue;
            }
            if entry.delivery_mode == "prompt" {
                continue;
            }
            deliver_nonblocking_entry(
                app.clone(),
                state,
                project_root,
                session_dir,
                &runtime_state,
                &entry,
            )?;
            delivered = true;
        }
        return Ok(delivered);
    }

    let mut next_entry = None;
    for entry in queue_entries {
        if entry.status != "queued" {
            continue;
        }
        if !agent_runtime::queue_entry_is_valid(&connection, &entry)? {
            let _ = agent_runtime::cancel_agent_queue_entry(&connection, &entry.id)?;
            continue;
        }
        next_entry = Some(entry);
        break;
    }
    let Some(entry) = next_entry else {
        return Ok(false);
    };

    let runtime_state = ensure_main_session(project_root, session_dir, project_id, agent_id)?;
    if entry.delivery_mode == "prompt" {
        deliver_prompt_entry(app, state, session_dir, &runtime_state, &entry)?;
    } else {
        deliver_nonblocking_entry(
            app,
            state,
            project_root,
            session_dir,
            &runtime_state,
            &entry,
        )?;
    }
    Ok(true)
}

pub fn complete_agent_run(session_id: &str, run_id: Option<&str>) -> Result<(), String> {
    let mut connection = crate::services::database::open_connection()?;
    let Some((project_id, agent_id)) = agent_for_session(&connection, session_id)? else {
        return Ok(());
    };
    if let Some(runtime_state) =
        agent_runtime::get_agent_runtime_state_for_project(&connection, &project_id, &agent_id)?
    {
        if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
            let queue_entry = agent_runtime::get_agent_queue_entry(&connection, queue_entry_id)?;
            if run_id.is_none() || queue_entry.run_id.as_deref() == run_id {
                let tx = connection.transaction().map_err(|error| {
                    format!("Unable to start agent completion transaction: {error}")
                })?;
                agent_runtime::mark_agent_queue_entry_completed(&tx, queue_entry_id)?;
                let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                    &tx,
                    &project_id,
                    &agent_id,
                    Some(session_id),
                    runtime_state.runtime_cwd.as_deref(),
                    None,
                    "idle",
                    None,
                )?;
                tx.commit().map_err(|error| {
                    format!("Unable to commit agent completion transaction: {error}")
                })?;
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
    let mut connection = crate::services::database::open_connection()?;
    let Some((project_id, agent_id)) = agent_for_session(&connection, session_id)? else {
        return Ok(());
    };
    if let Some(runtime_state) =
        agent_runtime::get_agent_runtime_state_for_project(&connection, &project_id, &agent_id)?
    {
        if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
            let queue_entry = agent_runtime::get_agent_queue_entry(&connection, queue_entry_id)?;
            if run_id.is_none() || queue_entry.run_id.as_deref() == run_id {
                let tx = connection.transaction().map_err(|error| {
                    format!("Unable to start agent failure transaction: {error}")
                })?;
                agent_runtime::mark_agent_queue_entry_failed(&tx, queue_entry_id)?;
                let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                    &tx,
                    &project_id,
                    &agent_id,
                    Some(session_id),
                    runtime_state.runtime_cwd.as_deref(),
                    None,
                    "needs_attention",
                    Some(error_message),
                )?;
                tx.commit().map_err(|error| {
                    format!("Unable to commit agent failure transaction: {error}")
                })?;
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
    if skip_cleared_mail_entry(&connection, entry)? {
        return Ok(());
    }
    let claimed = agent_runtime::mark_agent_queue_entry_dispatched(
        &connection,
        &entry.id,
        session_id,
        &run_id,
    )?;
    if claimed.is_none() {
        return Ok(());
    }
    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
        &connection,
        &runtime_state.project_id,
        &runtime_state.agent_id,
        Some(session_id),
        Some(runtime_cwd),
        Some(&entry.id),
        "running",
        None,
    )?;

    let actual_session_dir = pi_sessions::find_session_context_for_session(session_id)?.session_dir;
    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        actual_session_dir,
        session_id,
    )?;
    state.begin_session_run(session_id, &run_id)?;
    match runtime.start_delivery(&run_id, "prompt", &entry.message) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(session_id, &run_id);
            let _ = agent_runtime::mark_agent_queue_entry_failed(&connection, &entry.id);
            let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                &connection,
                &runtime_state.project_id,
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
    if skip_cleared_mail_entry(&connection, entry)? {
        return Ok(());
    }
    let claimed = agent_runtime::mark_agent_queue_entry_dispatched(
        &connection,
        &entry.id,
        session_id,
        &run_id,
    )?;
    if claimed.is_none() {
        return Ok(());
    }
    let actual_session_dir = pi_sessions::find_session_context_for_session(session_id)?.session_dir;
    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        actual_session_dir,
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

fn skip_cleared_mail_entry(
    connection: &rusqlite::Connection,
    entry: &AgentQueueEntry,
) -> Result<bool, String> {
    if entry.source_type != "mail" {
        return Ok(false);
    }
    if messages::agent_has_unread_direct_mail(connection, &entry.agent_id)? {
        return Ok(false);
    }
    agent_runtime::mark_agent_queue_entry_completed(connection, &entry.id)?;
    Ok(true)
}

pub fn ensure_main_session(
    project_root: &Path,
    session_dir: &Path,
    project_id: &str,
    agent_id: &str,
) -> Result<AgentRuntimeState, String> {
    let connection = crate::services::database::open_connection()?;
    let runtime_state =
        agent_runtime::ensure_agent_runtime_state_for_project(&connection, project_id, agent_id)?;

    // Use the effective project_id from the runtime state (may differ for global agents)
    let effective_project_id = &runtime_state.project_id;
    let runtime_cwd = project_root.display().to_string();

    if let Some(session_id) = runtime_state.main_session_id.as_deref() {
        if crate::services::pi_sessions::find_session_context_for_session(session_id).is_ok() {
            session_records::bind_session_context(
                &connection,
                session_id,
                session_records::SessionContextBinding {
                    project_id: Some(effective_project_id.as_str()),
                    session_kind: Some(session_records::SESSION_KIND_AGENT_MAIN),
                    worker_type: Some("agent"),
                    worker_id: Some(agent_id),
                    agent_id: Some(agent_id),
                    role_instance_id: None,
                    task_id: None,
                    workflow_id: None,
                    lane_id: None,
                    assignment_id: None,
                    runtime_cwd: Some(project_root),
                },
            )?;
            return Ok(runtime_state);
        }
    }

    if let Some(global_session_id) =
        agent_runtime::find_global_main_session_id(&connection, agent_id)?
    {
        if crate::services::pi_sessions::find_session_context_for_session(&global_session_id)
            .is_ok()
        {
            session_records::bind_session_context(
                &connection,
                &global_session_id,
                session_records::SessionContextBinding {
                    project_id: Some(effective_project_id.as_str()),
                    session_kind: Some(session_records::SESSION_KIND_AGENT_MAIN),
                    worker_type: Some("agent"),
                    worker_id: Some(agent_id),
                    agent_id: Some(agent_id),
                    role_instance_id: None,
                    task_id: None,
                    workflow_id: None,
                    lane_id: None,
                    assignment_id: None,
                    runtime_cwd: Some(project_root),
                },
            )?;
            let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                &connection,
                effective_project_id,
                agent_id,
                Some(&global_session_id),
                Some(runtime_cwd.as_str()),
                runtime_state.current_queue_entry_id.as_deref(),
                &runtime_state.status,
                runtime_state.last_error.as_deref(),
            )?;
            return agent_runtime::get_agent_runtime_state_for_project(
                &connection,
                effective_project_id,
                agent_id,
            )?
            .ok_or_else(|| format!("Agent runtime state for {agent_id} was not found after bind"));
        }
    }

    let agent = agents::get_agent(&connection, agent_id)?;
    let created = session_records::create_session_record(
        &connection,
        project_root,
        session_dir,
        session_records::CreateSessionRecordInput {
            project_id: Some(effective_project_id.as_str()),
            title: Some(&format!("{} main session", agent.name)),
            session_kind: session_records::SESSION_KIND_AGENT_MAIN,
            agent_id: Some(agent_id),
            role_instance_id: None,
            task_id: None,
            workflow_id: None,
            lane_id: None,
            assignment: None,
            worker_type: None,
            worker_id: None,
            runtime_cwd: Some(runtime_cwd.as_str()),
            subscribed: false,
            agent_runtime: Some(session_records::AgentRuntimeBinding {
                project_id: effective_project_id.as_str(),
                agent_id,
                runtime_cwd: Some(runtime_cwd.as_str()),
                current_queue_entry_id: runtime_state.current_queue_entry_id.as_deref(),
                status: &runtime_state.status,
                last_error: runtime_state.last_error.as_deref(),
            }),
            update_role_instance_session: false,
        },
    )?;
    if let (Some(provider), Some(model)) = (agent.provider.as_deref(), agent.model.as_deref()) {
        let _ = pi_sessions::set_session_model(
            project_root,
            session_dir,
            &created.record.id,
            provider,
            model,
        )?;
    }
    let _ = pi_sessions::set_session_thinking_level(
        project_root,
        session_dir,
        &created.record.id,
        &agent.thinking_level,
    )?;
    seed_direct_agent_session_context(
        &connection,
        session_dir,
        &created.record.id,
        &agent,
        Some(project_id),
    )?;
    agent_runtime::get_agent_runtime_state_for_project(&connection, effective_project_id, agent_id)?
        .ok_or_else(|| format!("Agent runtime state for {agent_id} was not found after create"))
}

fn agent_for_session(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<(String, String)>, String> {
    connection
        .query_row(
            "SELECT project_id, agent_id FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
            [session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve agent runtime for session {session_id}: {error}"))
}
