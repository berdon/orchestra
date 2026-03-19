mod commands;
mod models;
mod services;
mod state;

use commands::{
    agents::{
        archive_agent, create_agent, get_agent, get_agent_memory_info, list_agents, update_agent,
        validate_agent,
    },
    app::{clear_logs, get_app_info, get_logs, get_session_storage_info, open_logs_window},
    policies::{get_policy, list_policies},
    project_settings::{get_worker_overlay, update_worker_overlay},
    role_dispatch::{dispatch_role_queue, dispose_role_instance, release_role_instance},
    role_runtime::{enqueue_role_work, get_role_operations, list_role_operations},
    roles::{archive_role, create_role, get_role, list_roles, update_role, validate_role},
    sessions::{
        create_session, delete_session, get_session_model_state, list_sessions, resume_session,
        send_session_message, set_session_model, subscribe_session, unsubscribe_session,
    },
    workflows::{
        archive_workflow, create_workflow, duplicate_workflow, get_workflow, list_workflows,
        update_workflow, validate_workflow,
    },
};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::logging::init_logging();
    let database_path = services::database::initialize_database()
        .expect("unable to initialize Orchestra SQLite database");

    let app_state = AppState::new();
    app_state.log(
        "info",
        "storage.sqlite",
        &format!(
            "Initialized Orchestra SQLite database at {}",
            database_path.display()
        ),
    );

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_logs,
            clear_logs,
            open_logs_window,
            get_session_storage_info,
            list_agents,
            get_agent,
            validate_agent,
            create_agent,
            update_agent,
            archive_agent,
            get_agent_memory_info,
            list_policies,
            get_policy,
            get_worker_overlay,
            update_worker_overlay,
            list_sessions,
            create_session,
            delete_session,
            resume_session,
            subscribe_session,
            unsubscribe_session,
            get_session_model_state,
            set_session_model,
            send_session_message,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
