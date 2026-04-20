use tauri::{AppHandle, State};

use crate::{services::dispatcher, state::AppState};

#[tauri::command]
pub fn run_dispatcher_tick(app: AppHandle, _state: State<'_, AppState>) -> Result<(), String> {
    dispatcher::run_dispatcher_tick(app)
}
