use tauri::{AppHandle, State};

use crate::{
    models::{
        RemoteAccessSettingsInput, RemoteAccessStatus, RemoteDeviceRecord, RemotePairingCode,
        RemotePairingCodeInput,
    },
    services::{database, remote_access, remote_api},
    state::AppState,
};

#[tauri::command]
pub fn get_remote_access_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteAccessStatus, String> {
    let connection = database::open_connection()?;
    let _settings = remote_access::load_settings(&connection)?;
    drop(connection);
    if let Err(error) = remote_api::ensure_remote_api_server(app, &state) {
        let _ = state.set_remote_server_error(error.clone());
        state.log("error", "remote.api.server", &error);
    }
    remote_api::build_remote_access_status(&state)
}

#[tauri::command]
pub fn update_remote_access_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RemoteAccessSettingsInput,
) -> Result<RemoteAccessStatus, String> {
    let connection = database::open_connection()?;
    let previous_settings = remote_access::load_settings(&connection)?;
    let settings = remote_access::update_settings(&connection, input)?;
    drop(connection);

    if remote_access::tailscale_cleanup_required(&previous_settings, &settings) {
        let _ = remote_api::disable_remote_tailscale_api_route(previous_settings.port);
    }

    if settings.enabled {
        if let Err(error) = remote_api::ensure_remote_api_server(app, &state) {
            let _ = state.set_remote_server_error(error.clone());
            state.log("error", "remote.api.server", &error);
        }
    } else {
        remote_api::stop_remote_api_server(&state)?;
    }

    remote_api::build_remote_access_status(&state)
}

#[tauri::command]
pub fn create_remote_pairing_code(
    app: AppHandle,
    state: State<'_, AppState>,
    input: Option<RemotePairingCodeInput>,
) -> Result<RemotePairingCode, String> {
    let connection = database::open_connection()?;
    let settings = remote_access::load_settings(&connection)?;
    if settings.enabled {
        drop(connection);
        remote_api::ensure_remote_api_server(app, &state)?;
        let connection = database::open_connection()?;
        return remote_access::create_pairing_code(
            &connection,
            input.unwrap_or(RemotePairingCodeInput {
                label: None,
                platform: None,
            }),
        );
    }

    remote_access::create_pairing_code(
        &connection,
        input.unwrap_or(RemotePairingCodeInput {
            label: None,
            platform: None,
        }),
    )
}

#[tauri::command]
pub fn revoke_remote_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<RemoteDeviceRecord, String> {
    let connection = database::open_connection()?;
    let device = remote_access::revoke_device(&connection, &device_id)?;
    state.log(
        "info",
        "remote.api.device.revoke",
        &format!("Revoked remote device {}", device_id),
    );
    Ok(device)
}
