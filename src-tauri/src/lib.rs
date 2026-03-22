mod commands;
mod models;
mod services;
mod state;

use commands::{
    agent_runtime::{
        enqueue_agent_work, ensure_agent_session, get_agent_operations, list_agent_operations,
    },
    agents::{
        archive_agent, create_agent, get_agent, get_agent_memory_info, list_agents, update_agent,
        validate_agent,
    },
    app::{
        cleanup_stale_bridge_instances, clear_logs, get_app_info, get_bridge_diagnostics, get_logs,
        get_session_storage_info, list_pi_models, open_logs_window,
    },
    dispatcher::run_dispatcher_tick,
    policies::{
        get_agent_permissions, get_policy, get_role_instance_permissions, get_role_permissions,
        list_orchestra_tools, list_policies,
    },
    project_settings::{get_session_prompt_settings, get_worker_overlay, update_session_prompt_settings, update_worker_overlay},
    projects::{
        create_project, create_repository, delete_project, get_project, list_projects,
        list_repositories, set_project_default_repository, update_project, update_repository,
    },
    role_dispatch::{dispatch_role_queue, dispose_role_instance, release_role_instance},
    role_runtime::{enqueue_role_work, get_role_operations, list_role_operations},
    roles::{archive_role, create_role, get_role, list_roles, update_role, validate_role},
    sessions::{
        create_session, delete_session, get_session_model_state, get_session_record, list_sessions,
        resume_session, send_session_message, set_session_model, subscribe_session,
        unsubscribe_session,
    },
    tasks::{
        add_task_attachment, add_task_dependency, add_task_file_reference, comment_on_task,
        complete_lane_as_failure, complete_lane_as_success, create_subtask, create_task,
        delete_task, dispatch_task_lane, get_task, get_task_context, list_task_file_references,
        list_task_repositories, list_tasks, remove_task_attachment, remove_task_dependency,
        remove_task_file_reference, request_user_intervention, update_task,
    },
    workflows::{
        archive_workflow, create_workflow, duplicate_workflow, get_workflow, list_workflows,
        update_workflow, validate_workflow,
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
            services::dispatcher::start_dispatcher_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_logs,
            clear_logs,
            get_bridge_diagnostics,
            cleanup_stale_bridge_instances,
            open_logs_window,
            run_dispatcher_tick,
            get_session_storage_info,
            list_pi_models,
            list_agents,
            get_agent_operations,
            list_agent_operations,
            enqueue_agent_work,
            ensure_agent_session,
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
            list_repositories,
            create_repository,
            update_repository,
            set_project_default_repository,
            get_worker_overlay,
            update_worker_overlay,
            get_session_prompt_settings,
            update_session_prompt_settings,
            list_sessions,
            get_session_record,
            create_session,
            delete_session,
            resume_session,
            subscribe_session,
            unsubscribe_session,
            get_session_model_state,
            set_session_model,
            send_session_message,
            list_tasks,
            get_task,
            get_task_context,
            list_task_repositories,
            list_task_file_references,
            create_task,
            create_subtask,
            update_task,
            delete_task,
            comment_on_task,
            dispatch_task_lane,
            complete_lane_as_success,
            complete_lane_as_failure,
            request_user_intervention,
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
            dispatch_role_queue,
            release_role_instance,
            dispose_role_instance,
            list_workflows,
            get_workflow,
            validate_workflow,
            create_workflow,
            update_workflow,
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
        }
    });
}
