mod commands;
mod models;
mod services;
mod state;

use commands::{
    agent_runtime::{
        delete_agent_queue_entry, enqueue_agent_work, ensure_agent_session, get_agent_operations,
        get_agent_terminal_buffer, list_agent_operations, open_agent_session_terminal,
        resize_agent_terminal, shutdown_agent_terminal_session, write_agent_terminal_input,
    },
    agents::{
        archive_agent, create_agent, get_agent, get_agent_memory_info, list_agents, update_agent,
        validate_agent,
    },
    app::{
        cleanup_stale_bridge_instances, clear_logs, debug_seed_idle_task_whip_scenario,
        export_logs_bundle, get_app_info, get_bridge_diagnostics, get_logs,
        get_pi_executable_diagnostic, get_session_storage_info, list_pi_models, open_logs_window,
        report_client_error,
    },
    channels::{
        create_channel, delete_channel, get_channel, list_channel_activity, list_channels,
        list_telegram_chat_candidates, update_channel, validate_telegram_bot,
    },
    dispatcher::run_dispatcher_tick,
    messages::{
        archive_mailbox_messages, list_inbox_messages, list_task_messages,
        mark_mailbox_messages_read, send_mailbox_message,
    },
    policies::{
        get_agent_permissions, get_policy, get_role_instance_permissions, get_role_permissions,
        list_orchestra_tools, list_policies,
    },
    project_settings::{
        get_session_prompt_settings, get_task_automation_settings, get_worker_overlay,
        update_session_prompt_settings, update_task_automation_settings, update_worker_overlay,
    },
    projects::{
        attach_repository_remote, create_project, create_repository, delete_project,
        delete_repository, get_project, get_repository, list_projects, list_repositories,
        set_project_default_repository, update_project, update_repository,
    },
    role_dispatch::{
        dispatch_role_queue, dispose_role_instance, release_role_instance, reset_role_assignments,
    },
    role_runtime::{
        delete_role_queue_entry, enqueue_role_work, get_role_operations, list_role_operations,
    },
    roles::{archive_role, create_role, get_role, list_roles, update_role, validate_role},
    sessions::{
        compact_session, create_session, delete_session, get_session_model_state,
        get_session_record, list_sessions, resume_session, send_session_message, set_session_model,
        stop_session_runtime, subscribe_session, unsubscribe_session,
    },
    task_schedules::{
        create_task_schedule, delete_task_schedule, get_task_schedule, list_task_schedules,
        update_task_schedule,
    },
    tasks::{
        add_task_attachment, add_task_dependency, add_task_file_reference, add_task_todo,
        approve_lane_completion, comment_on_task, complete_lane_as_failure,
        complete_lane_as_success, create_subtask, create_task, delete_task, delete_task_comment,
        delete_task_todo, dispatch_task_lane, get_task, get_task_context, get_task_file_content,
        list_task_comments, list_task_file_references, list_task_repositories, list_task_todos,
        list_tasks, list_unfinished_task_todos, manual_task_whip, mark_task_todo_finished,
        mark_task_todo_unfinished, reassign_task_to_lane, remove_task_attachment,
        remove_task_dependency, remove_task_file_reference, request_user_intervention,
        reset_task_runtime, search_task_comment_file_mentions, send_lane_back_for_work,
        set_default_task_file_reference, update_task, update_task_comment,
    },
    workflows::{
        add_workflow_lane, archive_workflow, create_workflow, delete_workflow_lane,
        duplicate_workflow, get_workflow, list_workflows, reorder_workflow_lanes, update_workflow,
        update_workflow_lane, validate_workflow,
    },
};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::logging::init_logging();
    let database_path = services::database::initialize_database()
        .expect("unable to initialize Orchestra SQLite database");
    let tool_bridge =
        services::tool_bridge::start_tool_bridge().expect("unable to start Orchestra tool bridge");
    let mut bootstrap_connection = services::database::open_connection()
        .expect("unable to open Orchestra SQLite database for bootstrap");
    let (supervisor_policy, supervisor_agent) =
        services::auth_bootstrap::ensure_system_authorization_state(
            &mut bootstrap_connection,
            None,
        )
        .expect("unable to seed Orchestra supervisor authorization state");
    services::agent_runtime::reconcile_agent_runtime_states(&bootstrap_connection)
        .expect("unable to reconcile Orchestra agent runtime state");

    let app_state = AppState::new(tool_bridge.clone());
    app_state.log(
        "info",
        "storage.sqlite",
        &format!(
            "Initialized Orchestra SQLite database at {}",
            database_path.display()
        ),
    );
    app_state.log(
        "info",
        "auth.bootstrap",
        &format!(
            "Ensured supervisor policy {} and supervisor agent {}",
            supervisor_policy.id, supervisor_agent.id
        ),
    );
    app_state.log(
        "info",
        "tool.bridge",
        &format!("Started Orchestra tool bridge at {}", tool_bridge.url),
    );

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            state.tool_bridge.attach_app_handle(app.handle().clone());
            state.log(
                "info",
                "tool.bridge",
                &format!(
                    "Bridge instance {} attached to app handle at {}",
                    state.tool_bridge.instance_id, state.tool_bridge.url
                ),
            );
            for event in state.tool_bridge.diagnostics().recent_cleanup_events {
                state.log(
                    if event.success { "info" } else { "warn" },
                    "tool.bridge.cleanup",
                    &format!(
                        "startup action={} reason={} instance={:?} pid={:?}",
                        event.action, event.reason, event.instance_id, event.pid
                    ),
                );
            }
            services::channels::sync_channel_runtimes(app.handle().clone(), &state)?;
            services::startup_resume::resume_active_session_work_on_startup(app.handle().clone());
            services::dispatcher::start_dispatcher_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_logs,
            clear_logs,
            export_logs_bundle,
            report_client_error,
            get_bridge_diagnostics,
            cleanup_stale_bridge_instances,
            open_logs_window,
            debug_seed_idle_task_whip_scenario,
            list_channels,
            get_channel,
            list_channel_activity,
            create_channel,
            update_channel,
            delete_channel,
            validate_telegram_bot,
            list_telegram_chat_candidates,
            run_dispatcher_tick,
            get_session_storage_info,
            get_pi_executable_diagnostic,
            list_pi_models,
            list_agents,
            get_agent_operations,
            list_agent_operations,
            enqueue_agent_work,
            delete_agent_queue_entry,
            ensure_agent_session,
            open_agent_session_terminal,
            write_agent_terminal_input,
            resize_agent_terminal,
            get_agent_terminal_buffer,
            shutdown_agent_terminal_session,
            get_agent,
            validate_agent,
            create_agent,
            update_agent,
            archive_agent,
            get_agent_memory_info,
            list_policies,
            get_policy,
            get_agent_permissions,
            get_role_permissions,
            get_role_instance_permissions,
            list_orchestra_tools,
            list_projects,
            get_project,
            create_project,
            update_project,
            delete_project,
            list_inbox_messages,
            list_task_messages,
            send_mailbox_message,
            mark_mailbox_messages_read,
            archive_mailbox_messages,
            list_repositories,
            get_repository,
            create_repository,
            update_repository,
            delete_repository,
            attach_repository_remote,
            set_project_default_repository,
            get_worker_overlay,
            update_worker_overlay,
            get_session_prompt_settings,
            update_session_prompt_settings,
            get_task_automation_settings,
            update_task_automation_settings,
            list_sessions,
            get_session_record,
            create_session,
            delete_session,
            resume_session,
            subscribe_session,
            unsubscribe_session,
            stop_session_runtime,
            get_session_model_state,
            set_session_model,
            compact_session,
            send_session_message,
            list_tasks,
            list_task_schedules,
            get_task,
            get_task_context,
            get_task_schedule,
            list_task_comments,
            list_task_todos,
            list_unfinished_task_todos,
            search_task_comment_file_mentions,
            list_task_repositories,
            list_task_file_references,
            set_default_task_file_reference,
            get_task_file_content,
            create_task,
            create_task_schedule,
            create_subtask,
            add_task_todo,
            update_task,
            update_task_schedule,
            delete_task,
            delete_task_schedule,
            delete_task_todo,
            comment_on_task,
            update_task_comment,
            delete_task_comment,
            mark_task_todo_finished,
            mark_task_todo_unfinished,
            dispatch_task_lane,
            complete_lane_as_success,
            complete_lane_as_failure,
            request_user_intervention,
            approve_lane_completion,
            reassign_task_to_lane,
            send_lane_back_for_work,
            manual_task_whip,
            reset_task_runtime,
            add_task_dependency,
            remove_task_dependency,
            add_task_file_reference,
            remove_task_file_reference,
            add_task_attachment,
            remove_task_attachment,
            list_roles,
            get_role,
            validate_role,
            create_role,
            update_role,
            archive_role,
            list_role_operations,
            get_role_operations,
            enqueue_role_work,
            delete_role_queue_entry,
            dispatch_role_queue,
            release_role_instance,
            reset_role_assignments,
            dispose_role_instance,
            list_workflows,
            get_workflow,
            validate_workflow,
            create_workflow,
            update_workflow,
            add_workflow_lane,
            update_workflow_lane,
            delete_workflow_lane,
            reorder_workflow_lanes,
            duplicate_workflow,
            archive_workflow
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let state = app_handle.state::<AppState>();
            if let Ok(shutdown_count) = state.shutdown_all_session_runtimes() {
                if shutdown_count > 0 {
                    state.log(
                        "info",
                        "sessions.runtime.shutdown",
                        &format!(
                            "Shut down {} live pi runtimes during app exit",
                            shutdown_count
                        ),
                    );
                }
            }
            if let Ok(channel_shutdown_count) =
                services::channels::shutdown_all_channel_runtimes(&state)
            {
                if channel_shutdown_count > 0 {
                    state.log(
                        "info",
                        "channels.runtime.shutdown",
                        &format!(
                            "Shut down {} channel runtimes during app exit",
                            channel_shutdown_count
                        ),
                    );
                }
            }
        }
    });
}
