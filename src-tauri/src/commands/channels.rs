use tauri::{AppHandle, State};

use crate::{
    models::{
        ChannelActivityEntry, ChannelDetail, ChannelSummary, ChannelUpsertInput,
        TelegramBotValidation, TelegramChatCandidate,
    },
    services::{channels, database},
    state::AppState,
};

#[tauri::command]
pub fn list_channels() -> Result<Vec<ChannelSummary>, String> {
    let connection = database::open_connection()?;
    channels::list_channels(&connection)
}

#[tauri::command]
pub fn get_channel(channel_id: String) -> Result<ChannelDetail, String> {
    let connection = database::open_connection()?;
    channels::get_channel(&connection, &channel_id)
}

#[tauri::command]
pub fn list_channel_activity(
    channel_id: String,
    limit: Option<usize>,
) -> Result<Vec<ChannelActivityEntry>, String> {
    let connection = database::open_connection()?;
    channels::list_channel_activity(&connection, &channel_id, limit.unwrap_or(50))
}

#[tauri::command]
pub fn create_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ChannelUpsertInput,
) -> Result<ChannelDetail, String> {
    let connection = database::open_connection()?;
    let detail = channels::create_channel(&connection, input)?;
    channels::sync_channel_runtimes(app, &state)?;
    Ok(detail)
}

#[tauri::command]
pub fn update_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    channel_id: String,
    input: ChannelUpsertInput,
) -> Result<ChannelDetail, String> {
    let connection = database::open_connection()?;
    let detail = channels::update_channel(&connection, &channel_id, input)?;
    channels::sync_channel_runtimes(app, &state)?;
    Ok(detail)
}

#[tauri::command]
pub fn delete_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    channels::delete_channel(&connection, &channel_id)?;
    channels::sync_channel_runtimes(app, &state)?;
    Ok(())
}

#[tauri::command]
pub fn validate_telegram_bot(
    state: State<'_, AppState>,
    bot_token: String,
    api_base_url: Option<String>,
) -> Result<TelegramBotValidation, String> {
    match channels::validate_telegram_bot(&bot_token, api_base_url.as_deref()) {
        Ok(validation) => Ok(validation),
        Err(error) => {
            state.log("error", "channels.telegram.validate_bot.failed", &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn list_telegram_chat_candidates(
    state: State<'_, AppState>,
    bot_token: String,
    api_base_url: Option<String>,
) -> Result<Vec<TelegramChatCandidate>, String> {
    match channels::list_telegram_chat_candidates(&bot_token, api_base_url.as_deref()) {
        Ok(candidates) => Ok(candidates),
        Err(error) => {
            state.log("error", "channels.telegram.list_chat_candidates.failed", &error);
            Err(error)
        }
    }
}
