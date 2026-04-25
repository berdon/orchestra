mod cli;
mod commands;
mod models;
mod services;
mod state;

pub(crate) fn tauri_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

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
        cancel_pi_oauth_flow, cleanup_stale_bridge_instances, clear_logs,
        debug_seed_idle_task_whip_scenario, dismiss_pi_legacy_import, dismiss_pi_oauth_flow,
        export_logs_bundle, get_app_info, get_bridge_diagnostics, get_logs,
        get_pi_executable_diagnostic, get_pi_models_json, get_pi_oauth_flow_state,
        get_pi_runtime_diagnostics, get_pi_runtime_settings, get_pi_setup_state,
        get_session_storage_info, get_source_control_settings,
        get_system_notification_environment_status, get_system_notification_permission_state,
        import_legacy_pi_configuration, import_pi_legacy_config, list_pi_models, open_logs_window,
        preview_pi_legacy_import, remove_pi_provider_credential, report_client_error,
        request_system_notification_permission, save_pi_models_json, send_system_notification,
        set_pi_provider_api_key, start_pi_oauth_flow, submit_pi_oauth_flow_input,
        update_pi_runtime_settings, update_source_control_settings,
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
        get_project_source_control_settings, get_session_prompt_settings,
        get_task_automation_settings, get_worker_overlay, update_project_source_control_settings,
        update_session_prompt_settings, update_task_automation_settings, update_worker_overlay,
    },
    projects::{
        attach_repository_remote, create_project, create_repository, delete_project,
        delete_repository, get_project, get_repository, list_projects, list_repositories,
        set_project_default_repository, update_project, update_repository,
    },
    remote::{
        create_remote_pairing_code, get_remote_access_status, revoke_remote_device,
        update_remote_access_settings,
    },
    role_dispatch::{
        dispatch_role_queue, dispose_role_instance, release_role_instance, reset_role_assignments,
    },
    role_runtime::{
        delete_role_queue_entry, enqueue_role_work, get_role_operations, list_role_operations,
    },
    roles::{archive_role, create_role, get_role, list_roles, update_role, validate_role},
    sessions::{
        compact_session, create_contextual_session, create_session, delete_session,
        get_session_model_state, get_session_record, get_session_runtime_details,
        get_session_stats, list_sessions, reload_session, resume_session, send_session_message,
        set_session_model, stop_session_runtime, subscribe_session, unsubscribe_session,
    },
    skills::{
        archive_local_skill, create_local_skill, delete_local_skill, get_agent_skill_links,
        get_role_skill_links, get_skill, get_skills_catalog_diagnostics, get_workflow_skill_links,
        list_skills, refresh_external_skills, set_skill_bindings, unarchive_local_skill,
        update_local_skill,
    },
    task_schedules::{
        create_task_schedule, delete_task_schedule, get_task_schedule, list_task_schedules,
        update_task_schedule,
    },
    tasks::{
        add_task_attachment, add_task_dependency, add_task_file_reference, add_task_todo,
        approve_lane_completion, approve_task_review, comment_on_task, complete_lane_as_failure,
        complete_lane_as_success, create_subtask, create_task, delete_task, delete_task_comment,
        delete_task_todo, dispatch_task_lane, get_task, get_task_context, get_task_file_content,
        list_task_comments, list_task_file_references, list_task_repositories, list_task_todos,
        list_tasks, list_unfinished_task_todos, manual_task_whip, mark_task_comments_read_for_user,
        mark_task_needs_work, mark_task_todo_finished, mark_task_todo_unfinished, pause_task_lane,
        reassign_task_to_lane, remove_task_attachment, remove_task_dependency,
        remove_task_file_reference, request_user_intervention, reset_task_runtime,
        resume_task_lane, search_task_comment_file_mentions, send_lane_back_for_work,
        set_default_task_file_reference, stop_task_activity, update_task, update_task_comment,
    },
    workflows::{
        add_workflow_lane, archive_workflow, create_workflow, delete_workflow,
        delete_workflow_lane, duplicate_workflow, get_workflow, get_workflow_delete_impact,
        list_workflows, reorder_workflow_lanes, update_workflow, update_workflow_lane,
        validate_workflow,
    },
};
use state::AppState;
use std::env;
use tauri::Manager;

pub fn run_remote_api_route_probe(case: &str) -> Result<(), String> {
    services::remote_api::run_remote_api_route_probe(case)
}

pub fn run_hosted_web_e2e_server() -> Result<(), String> {
    services::remote_api::run_hosted_web_e2e_server()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bootstrap = services::backend_bootstrap::initialize_backend()
        .expect("unable to initialize Orchestra backend");
    let database_path = bootstrap.database_path;
    let tool_bridge = bootstrap.tool_bridge;
    let supervisor_policy = bootstrap.supervisor_policy;
    let supervisor_agent = bootstrap.supervisor_agent;
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
        "install.seed",
        "Ensured default install baseline project, roles, and workflows",
    );
    app_state.log(
        "info",
        "tool.bridge",
        &format!("Started Orchestra tool bridge at {}", tool_bridge.url),
    );

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_notification::init());
    let enable_webdriver_automation = env::var("ORCHESTRA_DESKTOP_E2E")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || env::var("ORCHESTRA_ENABLE_WEBDRIVER_AUTOMATION")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    if enable_webdriver_automation {
        builder = builder.plugin(tauri_plugin_webdriver_automation::init());
    }

    let app = builder
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            services::pi_runtime::register_app_handle(app.handle().clone());
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
            let _ = services::remote_api::ensure_remote_api_server(app.handle().clone(), &state);
            services::dispatcher::start_dispatcher_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_source_control_settings,
            update_source_control_settings,
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
            get_pi_runtime_settings,
            update_pi_runtime_settings,
            get_pi_setup_state,
            preview_pi_legacy_import,
            dismiss_pi_legacy_import,
            import_pi_legacy_config,
            get_pi_models_json,
            save_pi_models_json,
            set_pi_provider_api_key,
            remove_pi_provider_credential,
            get_pi_oauth_flow_state,
            start_pi_oauth_flow,
            submit_pi_oauth_flow_input,
            cancel_pi_oauth_flow,
            dismiss_pi_oauth_flow,
            get_pi_executable_diagnostic,
            get_pi_runtime_diagnostics,
            import_legacy_pi_configuration,
            get_system_notification_environment_status,
            get_system_notification_permission_state,
            request_system_notification_permission,
            send_system_notification,
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
            get_remote_access_status,
            update_remote_access_settings,
            create_remote_pairing_code,
            revoke_remote_device,
            get_session_prompt_settings,
            update_session_prompt_settings,
            get_task_automation_settings,
            update_task_automation_settings,
            get_project_source_control_settings,
            update_project_source_control_settings,
            list_sessions,
            get_session_record,
            get_session_runtime_details,
            create_session,
            create_contextual_session,
            delete_session,
            resume_session,
            subscribe_session,
            unsubscribe_session,
            stop_session_runtime,
            get_session_model_state,
            get_session_stats,
            set_session_model,
            compact_session,
            reload_session,
            send_session_message,
            list_tasks,
            list_task_schedules,
            get_task,
            get_task_context,
            get_task_schedule,
            list_task_comments,
            mark_task_comments_read_for_user,
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
            list_skills,
            get_skill,
            get_skills_catalog_diagnostics,
            create_local_skill,
            update_local_skill,
            archive_local_skill,
            unarchive_local_skill,
            delete_local_skill,
            refresh_external_skills,
            set_skill_bindings,
            get_role_skill_links,
            get_agent_skill_links,
            get_workflow_skill_links,
            comment_on_task,
            update_task_comment,
            delete_task_comment,
            mark_task_todo_finished,
            mark_task_todo_unfinished,
            dispatch_task_lane,
            complete_lane_as_success,
            complete_lane_as_failure,
            request_user_intervention,
            approve_task_review,
            approve_lane_completion,
            mark_task_needs_work,
            resume_task_lane,
            pause_task_lane,
            stop_task_activity,
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
            archive_workflow,
            get_workflow_delete_impact,
            delete_workflow
        ])
        .build(tauri_context())
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

pub fn run_orc_cli() -> Result<i32, String> {
    cli::run()
}
