mod commands;
mod models;
mod services;
mod state;

use commands::{
    app::{get_app_info, get_logs, get_session_storage_info},
    sessions::{
        create_session, get_session_model_state, list_sessions, resume_session,
        send_session_message, set_session_model, subscribe_session, unsubscribe_session,
    },
};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::logging::init_logging();

    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_logs,
            get_session_storage_info,
            list_sessions,
            create_session,
            resume_session,
            subscribe_session,
            unsubscribe_session,
            get_session_model_state,
            set_session_model,
            send_session_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
