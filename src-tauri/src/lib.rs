mod commands;
mod models;
mod services;
mod state;

use commands::app::{get_app_info, get_logs};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    services::logging::init_logging();

    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![get_app_info, get_logs])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
