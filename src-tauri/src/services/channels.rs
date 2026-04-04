use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use chrono::Utc;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    models::{
        ChannelActivityEntry, ChannelDetail, ChannelSummary, ChannelUpsertInput,
        TelegramBotValidation, TelegramChannelConfig, TelegramChannelConfigInput,
        TelegramChatCandidate,
    },
    services::{
        agent_dispatch, database,
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions, projects,
    },
    state::{generate_id, AppState},
};

const CHANNEL_KIND_TELEGRAM: &str = "telegram";
const CHANNEL_STATUS_NEEDS_SETUP: &str = "needs_setup";
const CHANNEL_STATUS_READY: &str = "ready";
const SOURCE_TYPE_CHANNEL: &str = "channel";
const DEFAULT_TARGET_AGENT_ID: &str = "agent-supervisor";
const DEFAULT_PROJECT_ID: &str = "orchestra";
const DIRECTION_INBOUND: &str = "inbound";
const DIRECTION_OUTBOUND: &str = "outbound";
const MESSAGE_KIND_MESSAGE: &str = "message";
const MESSAGE_KIND_COMMAND: &str = "command";
const MESSAGE_KIND_RESPONSE: &str = "response";
const MESSAGE_KIND_STATUS: &str = "status";
const TELEGRAM_CHAT_ACTION_TYPING: &str = "typing";
const ACTIVITY_STATUS_QUEUED: &str = "queued";
const ACTIVITY_STATUS_DISPATCHED: &str = "dispatched";
const ACTIVITY_STATUS_COMPLETED: &str = "completed";
const ACTIVITY_STATUS_FAILED: &str = "failed";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTelegramConfig {
    bot_username: Option<String>,
    api_base_url: Option<String>,
    chat_id: Option<String>,
    chat_title: Option<String>,
    chat_type: Option<String>,
    commands_enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChannelConfig {
    telegram: Option<StoredTelegramConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTelegramSecrets {
    bot_token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChannelSecrets {
    telegram: Option<StoredTelegramSecrets>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTelegramState {
    last_update_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChannelState {
    telegram: Option<StoredTelegramState>,
}

#[derive(Debug, Clone)]
struct StoredChannelRecord {
    id: String,
    kind: String,
    name: String,
    enabled: bool,
    status: String,
    target_agent_id: String,
    default_project_id: Option<String>,
    config: StoredChannelConfig,
    state: StoredChannelState,
    last_error: Option<String>,
    last_activity_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct RunOriginRecord {
    channel_id: String,
    channel_activity_id: String,
    project_id: Option<String>,
}

pub struct ChannelRuntimeHandle {
    stop: Arc<AtomicBool>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ChannelRuntimeHandle {
    fn new(stop: Arc<AtomicBool>, join: thread::JoinHandle<()>) -> Self {
        Self {
            stop,
            join: Mutex::new(Some(join)),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut join) = self.join.lock() {
            if let Some(join) = join.take() {
                let _ = join.join();
            }
        }
    }
}

pub fn list_channels(connection: &Connection) -> Result<Vec<ChannelSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT c.id, c.kind, c.name, c.enabled, c.status, c.target_agent_id, c.default_project_id,
                   p.name, c.last_error, c.last_activity_at, c.created_at, c.updated_at,
                   c.config_json, c.state_json
            FROM channels c
            LEFT JOIN projects p ON p.id = c.default_project_id
            ORDER BY c.updated_at DESC, c.name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare channel list query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(read_channel_record(row, 0, Some(7))?)
        })
        .map_err(|error| format!("Unable to query channels: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read channels: {error}"))?
        .into_iter()
        .map(|record| Ok(summarize_channel(record)))
        .collect()
}

pub fn get_channel(connection: &Connection, channel_id: &str) -> Result<ChannelDetail, String> {
    let (record, secrets) = load_channel(connection, channel_id)?;
    let secret_configured = secrets
        .telegram
        .and_then(|telegram| telegram.bot_token)
        .is_some();
    Ok(detail_channel(
        record,
        secret_configured,
        project_name_for_id(connection, channel_id).ok().flatten(),
    ))
}

pub fn list_channel_activity(
    connection: &Connection,
    channel_id: &str,
    limit: usize,
) -> Result<Vec<ChannelActivityEntry>, String> {
    let limit = limit.clamp(1, 200) as i64;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, channel_id, direction, message_kind, external_message_id, chat_id, session_id, run_id,
                   body, status, error, created_at, updated_at
            FROM channel_activity
            WHERE channel_id = ?1
            ORDER BY created_at DESC, id DESC
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("Unable to prepare channel activity query: {error}"))?;
    let rows = statement
        .query_map(params![channel_id, limit], read_channel_activity)
        .map_err(|error| format!("Unable to query channel activity: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read channel activity: {error}"))
}

pub fn create_channel(connection: &Connection, input: ChannelUpsertInput) -> Result<ChannelDetail, String> {
    let normalized = normalize_channel_input(connection, input, None)?;
    let now = now_iso();
    let id = format!("channel-{}", Uuid::new_v4().simple());
    let config_json = serde_json::to_string(&normalized.config)
        .map_err(|error| format!("Unable to serialize channel config: {error}"))?;
    let secret_json = serde_json::to_string(&normalized.secrets)
        .map_err(|error| format!("Unable to serialize channel secrets: {error}"))?;
    let state_json = serde_json::to_string(&StoredChannelState::default())
        .map_err(|error| format!("Unable to serialize channel state: {error}"))?;

    connection
        .execute(
            r#"
            INSERT INTO channels (
                id, kind, name, enabled, status, target_agent_id, default_project_id,
                config_json, state_json, last_error, last_activity_at, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?10)
            "#,
            params![
                id,
                normalized.kind,
                normalized.name,
                if normalized.enabled { 1 } else { 0 },
                normalized.status,
                normalized.target_agent_id,
                normalized.default_project_id,
                config_json,
                state_json,
                now,
            ],
        )
        .map_err(|error| format!("Unable to create channel: {error}"))?;
    connection
        .execute(
            "INSERT INTO channel_secrets (channel_id, secret_json, updated_at) VALUES (?1, ?2, ?3)",
            params![id, secret_json, now],
        )
        .map_err(|error| format!("Unable to create channel secrets: {error}"))?;

    get_channel(connection, &id)
}

pub fn update_channel(
    connection: &Connection,
    channel_id: &str,
    input: ChannelUpsertInput,
) -> Result<ChannelDetail, String> {
    let (existing, _) = load_channel(connection, channel_id)?;
    let normalized = normalize_channel_input(connection, input, Some(&existing))?;
    let now = now_iso();
    let config_json = serde_json::to_string(&normalized.config)
        .map_err(|error| format!("Unable to serialize channel config: {error}"))?;
    connection
        .execute(
            r#"
            UPDATE channels
            SET kind = ?2,
                name = ?3,
                enabled = ?4,
                status = ?5,
                target_agent_id = ?6,
                default_project_id = ?7,
                config_json = ?8,
                last_error = NULL,
                updated_at = ?9
            WHERE id = ?1
            "#,
            params![
                channel_id,
                normalized.kind,
                normalized.name,
                if normalized.enabled { 1 } else { 0 },
                normalized.status,
                normalized.target_agent_id,
                normalized.default_project_id,
                config_json,
                now,
            ],
        )
        .map_err(|error| format!("Unable to update channel {channel_id}: {error}"))?;

    if normalized.secrets_changed {
        let secret_json = serde_json::to_string(&normalized.secrets)
            .map_err(|error| format!("Unable to serialize channel secrets: {error}"))?;
        connection
            .execute(
                "INSERT INTO channel_secrets (channel_id, secret_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(channel_id) DO UPDATE SET secret_json = excluded.secret_json, updated_at = excluded.updated_at",
                params![channel_id, secret_json, now],
            )
            .map_err(|error| format!("Unable to update channel secrets {channel_id}: {error}"))?;
    }

    get_channel(connection, channel_id)
}

pub fn delete_channel(connection: &Connection, channel_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM channels WHERE id = ?1", [channel_id])
        .map_err(|error| format!("Unable to delete channel {channel_id}: {error}"))?;
    Ok(())
}

pub fn validate_telegram_bot(
    token: &str,
    api_base_url: Option<&str>,
) -> Result<TelegramBotValidation, String> {
    let response = telegram_api_post(token, api_base_url, "getMe", &json!({}))?;
    let result = response
        .get("result")
        .ok_or_else(|| "Telegram getMe response is missing a result payload".to_string())?;
    Ok(TelegramBotValidation {
        bot_id: json_string(result, "id")?,
        username: json_string(result, "username")?,
        display_name: result
            .get("first_name")
            .and_then(Value::as_str)
            .unwrap_or("Telegram bot")
            .to_string(),
    })
}

pub fn list_telegram_chat_candidates(
    token: &str,
    api_base_url: Option<&str>,
) -> Result<Vec<TelegramChatCandidate>, String> {
    let response = telegram_api_post(
        token,
        api_base_url,
        "getUpdates",
        &json!({ "timeout": 1, "limit": 50 }),
    )?;
    let updates = response
        .get("result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut by_chat_id = HashMap::new();
    for update in updates {
        let Some(message) = update.get("message") else {
            continue;
        };
        let Some(chat) = message.get("chat") else {
            continue;
        };
        let chat_id = chat.get("id").map(value_to_string).unwrap_or_default();
        if chat_id.is_empty() {
            continue;
        }
        let title = telegram_chat_title(chat);
        let candidate = TelegramChatCandidate {
            chat_id: chat_id.clone(),
            title,
            chat_type: chat.get("type").and_then(Value::as_str).unwrap_or("private").to_string(),
            username: chat.get("username").and_then(Value::as_str).map(ToOwned::to_owned),
            last_message_text: message.get("text").and_then(Value::as_str).map(ToOwned::to_owned),
            last_message_at: message.get("date").and_then(Value::as_i64).map(unix_timestamp_iso),
        };
        by_chat_id.insert(chat_id, candidate);
    }
    let mut candidates = by_chat_id.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.last_message_at.cmp(&left.last_message_at));
    Ok(candidates)
}

pub fn record_session_run_origin(
    connection: &Connection,
    run_id: &str,
    session_id: &str,
    channel_id: &str,
    channel_activity_id: &str,
    project_id: Option<&str>,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO session_run_origins (run_id, session_id, source_type, channel_id, channel_activity_id, project_id, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(run_id) DO UPDATE SET
                session_id = excluded.session_id,
                source_type = excluded.source_type,
                channel_id = excluded.channel_id,
                channel_activity_id = excluded.channel_activity_id,
                project_id = excluded.project_id,
                created_at = excluded.created_at
            "#,
            params![run_id, session_id, SOURCE_TYPE_CHANNEL, channel_id, channel_activity_id, project_id, now],
        )
        .map_err(|error| format!("Unable to record session run origin {run_id}: {error}"))?;
    Ok(())
}

pub fn deliver_channel_response_for_run(
    app: AppHandle,
    state: &AppState,
    session_id: &str,
    run_id: &str,
    response_text: &str,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    let Some(origin) = load_channel_run_origin(&connection, run_id)? else {
        return Ok(());
    };
    let (channel, secrets) = load_channel(&connection, &origin.channel_id)?;
    let token = secrets
        .telegram
        .and_then(|telegram| telegram.bot_token)
        .ok_or_else(|| format!("Channel {} is missing a Telegram bot token", channel.id))?;
    let telegram = channel
        .config
        .telegram
        .clone()
        .ok_or_else(|| format!("Channel {} is missing Telegram config", channel.id))?;
    let chat_id = telegram
        .chat_id
        .clone()
        .ok_or_else(|| format!("Channel {} is missing a Telegram chat id", channel.id))?;
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_COMPLETED, None)?;
        return Ok(());
    }

    let outbound_body = trimmed.to_string();
    telegram_api_post(
        &token,
        telegram.api_base_url.as_deref(),
        "sendMessage",
        &json!({ "chat_id": chat_id, "text": outbound_body }),
    )?;
    insert_channel_activity(
        &connection,
        &channel.id,
        DIRECTION_OUTBOUND,
        MESSAGE_KIND_RESPONSE,
        None,
        telegram.chat_id.as_deref(),
        Some(session_id),
        Some(run_id),
        trimmed,
        ACTIVITY_STATUS_COMPLETED,
        None,
    )?;
    mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_COMPLETED, None)?;
    state.log(
        "info",
        "channels.telegram.reply",
        &format!("Delivered channel response for run {} via {}", run_id, channel.name),
    );
    let _ = app;
    Ok(())
}

pub fn fail_channel_response_for_run(
    run_id: &str,
    error_message: &str,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    let Some(origin) = load_channel_run_origin(&connection, run_id)? else {
        return Ok(());
    };
    let current_status = connection
        .query_row(
            "SELECT status FROM channel_activity WHERE id = ?1 LIMIT 1",
            [origin.channel_activity_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query channel activity status for failed run {run_id}: {error}"))?;
    if matches!(current_status.as_deref(), Some(ACTIVITY_STATUS_FAILED) | Some(ACTIVITY_STATUS_COMPLETED)) {
        return Ok(());
    }
    let (channel, secrets) = load_channel(&connection, &origin.channel_id)?;
    let Some(telegram) = channel.config.telegram.clone() else {
        return mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_FAILED, Some(error_message));
    };
    let Some(token) = secrets.telegram.and_then(|entry| entry.bot_token) else {
        return mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_FAILED, Some(error_message));
    };
    let Some(chat_id) = telegram.chat_id.clone() else {
        return mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_FAILED, Some(error_message));
    };

    let body = format!("Supervisor run failed: {}", error_message);
    let _ = telegram_api_post(
        &token,
        telegram.api_base_url.as_deref(),
        "sendMessage",
        &json!({ "chat_id": chat_id, "text": body }),
    );
    let _ = insert_channel_activity(
        &connection,
        &channel.id,
        DIRECTION_OUTBOUND,
        MESSAGE_KIND_RESPONSE,
        None,
        telegram.chat_id.as_deref(),
        None,
        Some(run_id),
        &body,
        ACTIVITY_STATUS_FAILED,
        Some(error_message),
    );
    mark_channel_activity_status(&connection, &origin.channel_activity_id, ACTIVITY_STATUS_FAILED, Some(error_message))
}

pub fn sync_channel_runtimes(app: AppHandle, state: &AppState) -> Result<(), String> {
    let connection = database::open_connection()?;
    let desired = load_runnable_channels(&connection)?
        .into_iter()
        .map(|channel| channel.id)
        .collect::<Vec<_>>();
    drop(connection);

    let desired_set = desired.iter().cloned().collect::<std::collections::HashSet<_>>();
    let mut runtimes = state
        .channel_runtimes
        .lock()
        .map_err(|_| "Unable to access channel runtime state".to_string())?;

    let stale_ids = runtimes
        .keys()
        .filter(|id| !desired_set.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    for channel_id in stale_ids {
        if let Some(handle) = runtimes.remove(&channel_id) {
            handle.stop();
        }
    }

    for channel_id in desired {
        if runtimes.contains_key(&channel_id) {
            continue;
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&stop);
        let app_for_thread = app.clone();
        let channel_id_for_thread = channel_id.clone();
        let join = thread::spawn(move || {
            run_channel_loop(app_for_thread, channel_id_for_thread, stop_for_thread);
        });
        runtimes.insert(channel_id, ChannelRuntimeHandle::new(stop, join));
    }

    Ok(())
}

pub fn shutdown_all_channel_runtimes(state: &AppState) -> Result<usize, String> {
    let handles = state
        .channel_runtimes
        .lock()
        .map_err(|_| "Unable to access channel runtime state".to_string())?
        .drain()
        .map(|(_, handle)| handle)
        .collect::<Vec<_>>();
    let count = handles.len();
    for handle in handles {
        handle.stop();
    }
    Ok(count)
}

fn run_channel_loop(app: AppHandle, channel_id: String, stop: Arc<AtomicBool>) {
    let state = app.state::<AppState>();
    while !stop.load(Ordering::Relaxed) {
        let result = (|| -> Result<(), String> {
            let connection = database::open_connection()?;
            let (channel, secrets) = load_channel(&connection, &channel_id)?;
            if !channel.enabled || channel.status != CHANNEL_STATUS_READY || channel.kind != CHANNEL_KIND_TELEGRAM {
                return Ok(());
            }
            let token = secrets
                .telegram
                .and_then(|telegram| telegram.bot_token)
                .ok_or_else(|| format!("Channel {} is missing a Telegram bot token", channel_id))?;
            let telegram = channel
                .config
                .telegram
                .clone()
                .ok_or_else(|| format!("Channel {} is missing Telegram config", channel_id))?;
            let chat_id = telegram
                .chat_id
                .clone()
                .ok_or_else(|| format!("Channel {} is missing a Telegram chat id", channel_id))?;
            drop(connection);

            process_telegram_updates(&app, &state, &channel_id, &token, &telegram, &chat_id)?;
            dispatch_next_channel_message(&app, &state, &channel_id)?;
            Ok(())
        })();

        if let Err(error) = result {
            let _ = record_channel_runtime_error(&channel_id, &error);
            state.log(
                "error",
                "channels.runtime",
                &format!("Channel {} runtime error: {}", channel_id, error),
            );
        }

        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
}

fn process_telegram_updates(
    app: &AppHandle,
    state: &AppState,
    channel_id: &str,
    token: &str,
    telegram: &StoredTelegramConfig,
    expected_chat_id: &str,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    let (channel, _) = load_channel(&connection, channel_id)?;
    let offset = channel
        .state
        .telegram
        .as_ref()
        .and_then(|value| value.last_update_id)
        .map(|value| value + 1);

    let payload = if let Some(offset) = offset {
        json!({ "timeout": 1, "limit": 20, "offset": offset })
    } else {
        json!({ "timeout": 1, "limit": 20 })
    };
    let response = telegram_api_post(token, telegram.api_base_url.as_deref(), "getUpdates", &payload)?;
    let updates = response
        .get("result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut newest_update_id = channel
        .state
        .telegram
        .as_ref()
        .and_then(|value| value.last_update_id);

    for update in updates {
        newest_update_id = Some(std::cmp::max(
            newest_update_id.unwrap_or(i64::MIN),
            update.get("update_id").and_then(Value::as_i64).unwrap_or(i64::MIN),
        ));
        let Some(message) = update.get("message") else {
            continue;
        };
        let Some(chat) = message.get("chat") else {
            continue;
        };
        let chat_id = chat.get("id").map(value_to_string).unwrap_or_default();
        if chat_id != expected_chat_id {
            continue;
        }
        let external_message_id = message.get("message_id").map(value_to_string);
        let body = message.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if body.is_empty() {
            continue;
        }
        if body.starts_with('/') {
            handle_telegram_command(app, state, &channel, token, telegram, body, external_message_id.as_deref())?;
        } else {
            queue_inbound_channel_message(
                &connection,
                &channel.id,
                external_message_id.as_deref(),
                Some(&chat_id),
                body,
            )?;
            let _ = send_telegram_channel_message(
                &connection,
                &channel,
                MESSAGE_KIND_STATUS,
                "Queued for supervisor.",
                ACTIVITY_STATUS_COMPLETED,
                None,
                None,
            );
        }
    }

    if let Some(newest_update_id) = newest_update_id {
        update_channel_last_update_id(&database::open_connection()?, channel_id, newest_update_id)?;
    }

    Ok(())
}

fn handle_telegram_command(
    app: &AppHandle,
    state: &AppState,
    channel: &StoredChannelRecord,
    token: &str,
    telegram: &StoredTelegramConfig,
    body: &str,
    external_message_id: Option<&str>,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    let inbound = insert_channel_activity(
        &connection,
        &channel.id,
        DIRECTION_INBOUND,
        MESSAGE_KIND_COMMAND,
        external_message_id,
        telegram.chat_id.as_deref(),
        None,
        None,
        body,
        ACTIVITY_STATUS_COMPLETED,
        None,
    )?;
    let response = execute_telegram_command(app, state, channel, body)?;
    let secrets = load_channel_secrets(&connection, &channel.id)?;
    let chat_id = telegram
        .chat_id
        .clone()
        .ok_or_else(|| format!("Channel {} is missing a Telegram chat id", channel.id))?;
    let token = secrets
        .telegram
        .and_then(|entry| entry.bot_token)
        .ok_or_else(|| format!("Channel {} is missing a Telegram bot token", channel.id))?;
    telegram_api_post(
        &token,
        telegram.api_base_url.as_deref(),
        "sendMessage",
        &json!({ "chat_id": chat_id, "text": response }),
    )?;
    insert_channel_activity(
        &connection,
        &channel.id,
        DIRECTION_OUTBOUND,
        MESSAGE_KIND_COMMAND,
        None,
        telegram.chat_id.as_deref(),
        None,
        None,
        &response,
        ACTIVITY_STATUS_COMPLETED,
        None,
    )?;
    let _ = inbound;
    Ok(())
}

fn execute_telegram_command(
    app: &AppHandle,
    state: &AppState,
    channel: &StoredChannelRecord,
    body: &str,
) -> Result<String, String> {
    let trimmed = body.trim();
    let mut parts = trimmed.split_whitespace();
    let command = parts.next().unwrap_or("");
    let args = parts.collect::<Vec<_>>().join(" ");
    match command {
        "/start" | "/help" => Ok(telegram_help_text(channel)),
        "/status" => telegram_status_text(app, state, channel),
        "/project" => telegram_project_text(channel, args.trim()),
        "/model" => telegram_model_text(app, state, channel, args.trim()),
        "/stop" => telegram_stop_text(state, channel),
        "/resume" => {
            let resolved = ensure_channel_target_session(channel)?;
            Ok(format!("Supervisor session ready: {}", resolved.session_id))
        }
        _ => Ok("Unknown command. Use /help for available commands.".into()),
    }
}

fn telegram_help_text(channel: &StoredChannelRecord) -> String {
    format!(
        "{}\n\nPlain text messages are delivered to the supervisor.\n\nCommands:\n/help\n/status\n/project\n/project <slug>\n/model\n/model <provider>/<model>\n/stop\n/resume",
        channel.name
    )
}

fn telegram_status_text(app: &AppHandle, state: &AppState, channel: &StoredChannelRecord) -> Result<String, String> {
    let resolved = ensure_channel_target_session(channel)?;
    let session_context = pi_sessions::find_session_context_for_session(&resolved.session_id)?;
    let connection = database::open_connection()?;
    let session = pi_sessions::get_session(&session_context.session_dir, &resolved.session_id, false)?;
    let model_state = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &resolved.session_id) {
        runtime.get_model_state()?
    } else {
        pi_sessions::get_session_model_state(&resolved.project_root, &session_context.session_dir, &resolved.session_id)?
    };
    let current_model = model_state
        .current_model
        .map(|model| format!("{}/{}", model.provider, model.id))
        .unwrap_or_else(|| "unconfigured".into());
    let _ = app;
    let project_name = projects::get_project(&connection, &resolved.project_id)?.name;
    Ok(format!(
        "Supervisor session: {}\nStatus: {}\nDefault project: {}\nModel: {}\nUpdated: {}",
        session.title,
        session.status,
        project_name,
        current_model,
        session.updated_at,
    ))
}

fn telegram_project_text(channel: &StoredChannelRecord, args: &str) -> Result<String, String> {
    let connection = database::open_connection()?;
    if args.is_empty() {
        let project_name = channel
            .default_project_id
            .as_deref()
            .map(|project_id| projects::get_project(&connection, project_id).map(|project| project.name))
            .transpose()?
            .unwrap_or_else(|| "Orchestra".into());
        return Ok(format!("Current default project: {}", project_name));
    }

    let projects_list = projects::list_projects(&connection)?;
    let Some(project) = projects_list
        .into_iter()
        .find(|project| project.slug == args || project.id == args || project.name.eq_ignore_ascii_case(args))
    else {
        return Err(format!("Project '{}' was not found", args));
    };

    update_channel(
        &connection,
        &channel.id,
        ChannelUpsertInput {
            kind: None,
            name: None,
            enabled: None,
            target_agent_id: None,
            default_project_id: Some(project.id.clone()),
            telegram: None,
        },
    )?;
    Ok(format!("Default project set to {}.", project.name))
}

fn telegram_model_text(
    app: &AppHandle,
    state: &AppState,
    channel: &StoredChannelRecord,
    args: &str,
) -> Result<String, String> {
    let resolved = ensure_channel_target_session(channel)?;
    let session_context = pi_sessions::find_session_context_for_session(&resolved.session_id)?;
    if args.is_empty() {
        let model_state = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &resolved.session_id) {
            runtime.get_model_state()?
        } else {
            pi_sessions::get_session_model_state(&resolved.project_root, &session_context.session_dir, &resolved.session_id)?
        };
        let current_model = model_state
            .current_model
            .map(|model| format!("{}/{}", model.provider, model.id))
            .unwrap_or_else(|| "unconfigured".into());
        return Ok(format!("Current model: {}", current_model));
    }

    let (provider, model_id) = args
        .split_once('/')
        .ok_or_else(|| "Expected /model <provider>/<model>".to_string())?;
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &resolved.session_id) {
        runtime.set_model(provider, model_id)?;
    } else {
        pi_sessions::set_session_model(&resolved.project_root, &session_context.session_dir, &resolved.session_id, provider, model_id)?;
    }
    let _ = app;
    Ok(format!("Model changed to {}/{}.", provider, model_id))
}

fn telegram_stop_text(state: &AppState, channel: &StoredChannelRecord) -> Result<String, String> {
    let resolved = ensure_channel_target_session(channel)?;
    if let Some(runtime) = state.remove_session_runtime(&resolved.session_id)? {
        runtime.abort_active_run();
    }
    state.clear_active_session_run(&resolved.session_id)?;
    Ok("Stopped supervisor activity.".into())
}

fn dispatch_next_channel_message(app: &AppHandle, state: &AppState, channel_id: &str) -> Result<(), String> {
    let connection = database::open_connection()?;
    let (channel, _) = load_channel(&connection, channel_id)?;
    let Some(activity) = next_queued_inbound_message(&connection, channel_id)? else {
        return Ok(());
    };
    let resolved = ensure_channel_target_session(&channel)?;
    let existing_runtime = maybe_runtime(&state.session_runtimes, &resolved.session_id);
    let runtime_has_active_prompt = existing_runtime
        .as_ref()
        .map(|runtime| runtime.has_active_prompt())
        .unwrap_or(false);

    match resolve_channel_dispatch_plan(state.is_session_running(&resolved.session_id)?, runtime_has_active_prompt) {
        ChannelDispatchPlan::WaitForActiveRun => return Ok(()),
        ChannelDispatchPlan::RecoverStaleRunState => {
            state.clear_active_session_run(&resolved.session_id)?;
        }
        ChannelDispatchPlan::DispatchNow => {}
    }

    let session_context = pi_sessions::find_session_context_for_session(&resolved.session_id)?;
    let runtime = if let Some(runtime) = existing_runtime {
        runtime
    } else {
        ensure_runtime(
            &state.session_runtimes,
            app.clone(),
            resolved.project_root.clone(),
            session_context.session_dir.clone(),
            &resolved.session_id,
        )?
    };
    if state.subscribed_session_ids()?.contains(&resolved.session_id) {
        runtime.set_subscribed(true);
    }

    let run_id = generate_id("channel-run");
    let wrapped = wrap_channel_prompt(&channel, &resolved.name, &activity.body);
    state.begin_session_run(&resolved.session_id, &run_id)?;
    match runtime.start_delivery(&run_id, "prompt", &wrapped) {
        Ok(()) => {
            mark_channel_activity_dispatched(&connection, &activity.id, &resolved.session_id, &run_id)?;
            record_session_run_origin(
                &connection,
                &run_id,
                &resolved.session_id,
                &channel.id,
                &activity.id,
                Some(&resolved.project_id),
            )?;
            let _ = send_telegram_chat_action(&connection, &channel, TELEGRAM_CHAT_ACTION_TYPING);
            Ok(())
        }
        Err(error) => {
            let _ = state.end_session_run(&resolved.session_id, &run_id);
            mark_channel_activity_status(&connection, &activity.id, ACTIVITY_STATUS_FAILED, Some(&error))?;
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChannelDispatchPlan {
    DispatchNow,
    WaitForActiveRun,
    RecoverStaleRunState,
}

fn resolve_channel_dispatch_plan(session_marked_running: bool, runtime_has_active_prompt: bool) -> ChannelDispatchPlan {
    if runtime_has_active_prompt {
        ChannelDispatchPlan::WaitForActiveRun
    } else if session_marked_running {
        ChannelDispatchPlan::RecoverStaleRunState
    } else {
        ChannelDispatchPlan::DispatchNow
    }
}

fn ensure_channel_target_session(channel: &StoredChannelRecord) -> Result<ResolvedProjectContext, String> {
    let connection = database::open_connection()?;
    let project_id = channel.default_project_id.as_deref().unwrap_or(DEFAULT_PROJECT_ID);
    let project = projects::get_project(&connection, project_id)?;
    let context = pi_sessions::session_context_for_project_id(project_id)?;
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        project_id,
        &channel.target_agent_id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .ok_or_else(|| format!("Agent {} does not have a main session", channel.target_agent_id))?;
    Ok(ResolvedProjectContext {
        project_id: project.id,
        name: project.name,
        project_root: context.project_root,
        session_id,
    })
}

#[derive(Debug, Clone)]
struct ResolvedProjectContext {
    project_id: String,
    name: String,
    project_root: std::path::PathBuf,
    session_id: String,
}

fn wrap_channel_prompt(channel: &StoredChannelRecord, project_name: &str, body: &str) -> String {
    format!(
        "A Telegram message arrived through the external channel '{channel_name}' for project '{project_name}'.\nTreat this as a human operator message in that project context. Reply conversationally for the Telegram user, but keep using Orchestra as the source of truth.\n\nTelegram message:\n{body}",
        channel_name = channel.name,
        project_name = project_name,
        body = body.trim(),
    )
}

fn queue_inbound_channel_message(
    connection: &Connection,
    channel_id: &str,
    external_message_id: Option<&str>,
    chat_id: Option<&str>,
    body: &str,
) -> Result<(), String> {
    if let Some(external_message_id) = external_message_id {
        let existing = connection
            .query_row(
                "SELECT 1 FROM channel_activity WHERE channel_id = ?1 AND direction = ?2 AND external_message_id = ?3 LIMIT 1",
                params![channel_id, DIRECTION_INBOUND, external_message_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to query existing channel activity: {error}"))?;
        if existing.is_some() {
            return Ok(());
        }
    }

    let _ = insert_channel_activity(
        connection,
        channel_id,
        DIRECTION_INBOUND,
        MESSAGE_KIND_MESSAGE,
        external_message_id,
        chat_id,
        None,
        None,
        body,
        ACTIVITY_STATUS_QUEUED,
        None,
    )?;
    Ok(())
}

fn next_queued_inbound_message(
    connection: &Connection,
    channel_id: &str,
) -> Result<Option<ChannelActivityEntry>, String> {
    connection
        .query_row(
            r#"
            SELECT id, channel_id, direction, message_kind, external_message_id, chat_id, session_id, run_id,
                   body, status, error, created_at, updated_at
            FROM channel_activity
            WHERE channel_id = ?1 AND direction = ?2 AND message_kind = ?3 AND status = ?4
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            "#,
            params![channel_id, DIRECTION_INBOUND, MESSAGE_KIND_MESSAGE, ACTIVITY_STATUS_QUEUED],
            read_channel_activity,
        )
        .optional()
        .map_err(|error| format!("Unable to query queued channel message: {error}"))
}

fn mark_channel_activity_dispatched(
    connection: &Connection,
    activity_id: &str,
    session_id: &str,
    run_id: &str,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE channel_activity SET session_id = ?2, run_id = ?3, status = ?4, updated_at = ?5 WHERE id = ?1",
            params![activity_id, session_id, run_id, ACTIVITY_STATUS_DISPATCHED, now],
        )
        .map_err(|error| format!("Unable to mark channel activity dispatched: {error}"))?;
    Ok(())
}

fn mark_channel_activity_status(
    connection: &Connection,
    activity_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE channel_activity SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
            params![activity_id, status, error, now],
        )
        .map_err(|error| format!("Unable to update channel activity status: {error}"))?;
    Ok(())
}

fn insert_channel_activity(
    connection: &Connection,
    channel_id: &str,
    direction: &str,
    message_kind: &str,
    external_message_id: Option<&str>,
    chat_id: Option<&str>,
    session_id: Option<&str>,
    run_id: Option<&str>,
    body: &str,
    status: &str,
    error: Option<&str>,
) -> Result<ChannelActivityEntry, String> {
    let id = format!("channel-activity-{}", Uuid::new_v4().simple());
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO channel_activity (
                id, channel_id, direction, message_kind, external_message_id, chat_id,
                session_id, run_id, body, status, error, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
            "#,
            params![id, channel_id, direction, message_kind, external_message_id, chat_id, session_id, run_id, body, status, error, now],
        )
        .map_err(|error| format!("Unable to insert channel activity: {error}"))?;
    update_channel_activity_timestamps(connection, channel_id, error)?;
    connection
        .query_row(
            r#"
            SELECT id, channel_id, direction, message_kind, external_message_id, chat_id, session_id, run_id,
                   body, status, error, created_at, updated_at
            FROM channel_activity
            WHERE id = ?1
            "#,
            [id],
            read_channel_activity,
        )
        .map_err(|error| format!("Unable to read inserted channel activity: {error}"))
}

fn update_channel_activity_timestamps(
    connection: &Connection,
    channel_id: &str,
    last_error: Option<&str>,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE channels SET last_activity_at = ?2, last_error = ?3, updated_at = ?2 WHERE id = ?1",
            params![channel_id, now, last_error],
        )
        .map_err(|error| format!("Unable to update channel activity timestamp: {error}"))?;
    Ok(())
}

fn send_telegram_channel_message(
    connection: &Connection,
    channel: &StoredChannelRecord,
    message_kind: &str,
    body: &str,
    status: &str,
    run_id: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let secrets = load_channel_secrets(connection, &channel.id)?;
    let telegram = channel
        .config
        .telegram
        .clone()
        .ok_or_else(|| format!("Channel {} is missing Telegram config", channel.id))?;
    let token = secrets
        .telegram
        .and_then(|entry| entry.bot_token)
        .ok_or_else(|| format!("Channel {} is missing a Telegram bot token", channel.id))?;
    let chat_id = telegram
        .chat_id
        .clone()
        .ok_or_else(|| format!("Channel {} is missing a Telegram chat id", channel.id))?;

    telegram_api_post(
        &token,
        telegram.api_base_url.as_deref(),
        "sendMessage",
        &json!({ "chat_id": chat_id, "text": body }),
    )?;
    let _ = insert_channel_activity(
        connection,
        &channel.id,
        DIRECTION_OUTBOUND,
        message_kind,
        None,
        telegram.chat_id.as_deref(),
        None,
        run_id,
        body,
        status,
        error,
    )?;
    Ok(())
}

fn send_telegram_chat_action(
    connection: &Connection,
    channel: &StoredChannelRecord,
    action: &str,
) -> Result<(), String> {
    let secrets = load_channel_secrets(connection, &channel.id)?;
    let telegram = channel
        .config
        .telegram
        .clone()
        .ok_or_else(|| format!("Channel {} is missing Telegram config", channel.id))?;
    let token = secrets
        .telegram
        .and_then(|entry| entry.bot_token)
        .ok_or_else(|| format!("Channel {} is missing a Telegram bot token", channel.id))?;
    let chat_id = telegram
        .chat_id
        .clone()
        .ok_or_else(|| format!("Channel {} is missing a Telegram chat id", channel.id))?;

    telegram_api_post(
        &token,
        telegram.api_base_url.as_deref(),
        "sendChatAction",
        &json!({ "chat_id": chat_id, "action": action }),
    )?;
    Ok(())
}

fn update_channel_last_update_id(
    connection: &Connection,
    channel_id: &str,
    last_update_id: i64,
) -> Result<(), String> {
    let (mut channel, _) = load_channel(connection, channel_id)?;
    let mut telegram_state = channel.state.telegram.unwrap_or_default();
    telegram_state.last_update_id = Some(last_update_id);
    channel.state.telegram = Some(telegram_state);
    let state_json = serde_json::to_string(&channel.state)
        .map_err(|error| format!("Unable to serialize channel state: {error}"))?;
    connection
        .execute(
            "UPDATE channels SET state_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![channel_id, state_json, now_iso()],
        )
        .map_err(|error| format!("Unable to update channel polling cursor: {error}"))?;
    Ok(())
}

fn load_channel_run_origin(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<RunOriginRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT channel_id, channel_activity_id, project_id
            FROM session_run_origins
            WHERE run_id = ?1 AND source_type = ?2
            LIMIT 1
            "#,
            params![run_id, SOURCE_TYPE_CHANNEL],
            |row| {
                Ok(RunOriginRecord {
                    channel_id: row.get(0)?,
                    channel_activity_id: row.get(1)?,
                    project_id: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query run origin {run_id}: {error}"))
}

fn load_channel(
    connection: &Connection,
    channel_id: &str,
) -> Result<(StoredChannelRecord, StoredChannelSecrets), String> {
    let record = connection
        .query_row(
            r#"
            SELECT c.id, c.kind, c.name, c.enabled, c.status, c.target_agent_id, c.default_project_id,
                   p.name, c.last_error, c.last_activity_at, c.created_at, c.updated_at,
                   c.config_json, c.state_json
            FROM channels c
            LEFT JOIN projects p ON p.id = c.default_project_id
            WHERE c.id = ?1
            LIMIT 1
            "#,
            [channel_id],
            |row| read_channel_record(row, 0, Some(7)),
        )
        .optional()
        .map_err(|error| format!("Unable to query channel {channel_id}: {error}"))?
        .ok_or_else(|| format!("Channel {channel_id} was not found"))?;
    let secrets = load_channel_secrets(connection, channel_id)?;
    Ok((record, secrets))
}

fn load_channel_secrets(connection: &Connection, channel_id: &str) -> Result<StoredChannelSecrets, String> {
    let secret_json = connection
        .query_row(
            "SELECT secret_json FROM channel_secrets WHERE channel_id = ?1 LIMIT 1",
            [channel_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query channel secrets {channel_id}: {error}"))?
        .unwrap_or_else(|| "{}".into());
    serde_json::from_str(&secret_json)
        .map_err(|error| format!("Unable to parse channel secrets {channel_id}: {error}"))
}

fn load_runnable_channels(connection: &Connection) -> Result<Vec<StoredChannelRecord>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT c.id, c.kind, c.name, c.enabled, c.status, c.target_agent_id, c.default_project_id,
                   p.name, c.last_error, c.last_activity_at, c.created_at, c.updated_at,
                   c.config_json, c.state_json
            FROM channels c
            LEFT JOIN projects p ON p.id = c.default_project_id
            WHERE c.enabled = 1 AND c.status = ?1
            ORDER BY c.updated_at DESC, c.name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare runnable channel query: {error}"))?;
    let rows = statement
        .query_map([CHANNEL_STATUS_READY], |row| read_channel_record(row, 0, Some(7)))
        .map_err(|error| format!("Unable to query runnable channels: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read runnable channels: {error}"))
}

fn normalize_channel_input(
    connection: &Connection,
    input: ChannelUpsertInput,
    existing: Option<&StoredChannelRecord>,
) -> Result<NormalizedChannelInput, String> {
    let kind = input
        .kind
        .or_else(|| existing.map(|value| value.kind.clone()))
        .unwrap_or_else(|| CHANNEL_KIND_TELEGRAM.into())
        .trim()
        .to_lowercase();
    if kind != CHANNEL_KIND_TELEGRAM {
        return Err(format!("Unsupported channel kind: {}", kind));
    }

    let name = input
        .name
        .or_else(|| existing.map(|value| value.name.clone()))
        .unwrap_or_else(|| "Telegram".into())
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Channel name is required.".into());
    }

    let target_agent_id = input
        .target_agent_id
        .or_else(|| existing.map(|value| value.target_agent_id.clone()))
        .unwrap_or_else(|| DEFAULT_TARGET_AGENT_ID.into())
        .trim()
        .to_string();
    crate::services::agents::get_agent(connection, &target_agent_id)?;

    let default_project_id = input
        .default_project_id
        .or_else(|| existing.and_then(|value| value.default_project_id.clone()))
        .or_else(|| Some(DEFAULT_PROJECT_ID.into()))
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        });
    if let Some(project_id) = default_project_id.as_deref() {
        projects::ensure_project_exists(connection, project_id)?;
    }

    let provided_new_bot_token = input
        .telegram
        .as_ref()
        .and_then(|telegram| telegram.bot_token.as_ref())
        .is_some();
    let telegram_input = input.telegram.clone().unwrap_or_else(|| TelegramChannelConfigInput {
        bot_token: None,
        api_base_url: None,
        chat_id: None,
        chat_title: None,
        chat_type: None,
        commands_enabled: existing
            .and_then(|value| value.config.telegram.as_ref().map(|telegram| telegram.commands_enabled))
            .unwrap_or(true),
    });
    let existing_config = existing.and_then(|value| value.config.telegram.clone()).unwrap_or_default();
    let existing_secrets = existing
        .and_then(|value| load_channel_secrets(connection, &value.id).ok())
        .and_then(|secrets| secrets.telegram)
        .unwrap_or_default();

    let telegram_config = StoredTelegramConfig {
        bot_username: telegram_input
            .bot_token
            .as_ref()
            .and_then(|_| None)
            .or(existing_config.bot_username),
        api_base_url: normalize_optional(telegram_input.api_base_url).or(existing.and_then(|value| value.config.telegram.as_ref().and_then(|telegram| telegram.api_base_url.clone()))),
        chat_id: normalize_optional(telegram_input.chat_id).or(existing.and_then(|value| value.config.telegram.as_ref().and_then(|telegram| telegram.chat_id.clone()))),
        chat_title: normalize_optional(telegram_input.chat_title).or(existing.and_then(|value| value.config.telegram.as_ref().and_then(|telegram| telegram.chat_title.clone()))),
        chat_type: normalize_optional(telegram_input.chat_type).or(existing.and_then(|value| value.config.telegram.as_ref().and_then(|telegram| telegram.chat_type.clone()))),
        commands_enabled: telegram_input.commands_enabled || existing_config.commands_enabled,
    };

    let bot_token = normalize_optional(telegram_input.bot_token).or(existing_secrets.bot_token);
    let secret_configured = bot_token.as_ref().is_some();
    let status = if secret_configured && telegram_config.chat_id.as_ref().is_some() {
        CHANNEL_STATUS_READY.to_string()
    } else {
        CHANNEL_STATUS_NEEDS_SETUP.to_string()
    };

    let enabled = input.enabled.unwrap_or_else(|| existing.map(|value| value.enabled).unwrap_or(false));

    Ok(NormalizedChannelInput {
        kind,
        name,
        enabled: enabled && status == CHANNEL_STATUS_READY,
        status,
        target_agent_id,
        default_project_id,
        config: StoredChannelConfig {
            telegram: Some(telegram_config),
        },
        secrets: StoredChannelSecrets {
            telegram: Some(StoredTelegramSecrets { bot_token }),
        },
        secrets_changed: provided_new_bot_token || existing.is_none(),
    })
}

struct NormalizedChannelInput {
    kind: String,
    name: String,
    enabled: bool,
    status: String,
    target_agent_id: String,
    default_project_id: Option<String>,
    config: StoredChannelConfig,
    secrets: StoredChannelSecrets,
    secrets_changed: bool,
}

fn read_channel_record(
    row: &rusqlite::Row<'_>,
    base_index: usize,
    project_name_index: Option<usize>,
) -> rusqlite::Result<StoredChannelRecord> {
    let config_json = row.get::<_, String>(base_index + 12)?;
    let state_json = row.get::<_, String>(base_index + 13)?;
    let _project_name = project_name_index.map(|index| row.get::<_, Option<String>>(index)).transpose()?;
    Ok(StoredChannelRecord {
        id: row.get(base_index + 0)?,
        kind: row.get(base_index + 1)?,
        name: row.get(base_index + 2)?,
        enabled: row.get::<_, i64>(base_index + 3)? != 0,
        status: row.get(base_index + 4)?,
        target_agent_id: row.get(base_index + 5)?,
        default_project_id: row.get(base_index + 6)?,
        config: serde_json::from_str(&config_json).unwrap_or_default(),
        state: serde_json::from_str(&state_json).unwrap_or_default(),
        last_error: row.get(base_index + 8)?,
        last_activity_at: row.get(base_index + 9)?,
        created_at: row.get(base_index + 10)?,
        updated_at: row.get(base_index + 11)?,
    })
}

fn summarize_channel(record: StoredChannelRecord) -> ChannelSummary {
    ChannelSummary {
        id: record.id,
        kind: record.kind,
        name: record.name,
        enabled: record.enabled,
        status: record.status,
        target_agent_id: record.target_agent_id,
        default_project_id: record.default_project_id,
        default_project_name: None,
        last_error: record.last_error,
        last_activity_at: record.last_activity_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn detail_channel(
    record: StoredChannelRecord,
    secret_configured: bool,
    default_project_name: Option<String>,
) -> ChannelDetail {
    ChannelDetail {
        id: record.id,
        kind: record.kind,
        name: record.name,
        enabled: record.enabled,
        status: record.status,
        target_agent_id: record.target_agent_id,
        default_project_id: record.default_project_id,
        default_project_name,
        secret_configured,
        telegram: record.config.telegram.map(|telegram| TelegramChannelConfig {
            bot_username: telegram.bot_username,
            api_base_url: telegram.api_base_url,
            chat_id: telegram.chat_id,
            chat_title: telegram.chat_title,
            chat_type: telegram.chat_type,
            commands_enabled: telegram.commands_enabled,
        }),
        last_error: record.last_error,
        last_activity_at: record.last_activity_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn project_name_for_id(connection: &Connection, channel_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT p.name
            FROM channels c
            LEFT JOIN projects p ON p.id = c.default_project_id
            WHERE c.id = ?1
            LIMIT 1
            "#,
            [channel_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query project name for channel {channel_id}: {error}"))
        .map(|value| value.flatten())
}

fn read_channel_activity(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChannelActivityEntry> {
    Ok(ChannelActivityEntry {
        id: row.get(0)?,
        channel_id: row.get(1)?,
        direction: row.get(2)?,
        message_kind: row.get(3)?,
        external_message_id: row.get(4)?,
        chat_id: row.get(5)?,
        session_id: row.get(6)?,
        run_id: row.get(7)?,
        body: row.get(8)?,
        status: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn record_channel_runtime_error(channel_id: &str, error: &str) -> Result<(), String> {
    let connection = database::open_connection()?;
    connection
        .execute(
            "UPDATE channels SET last_error = ?2, updated_at = ?3 WHERE id = ?1",
            params![channel_id, error, now_iso()],
        )
        .map_err(|update_error| format!("Unable to update channel runtime error: {update_error}"))?;
    Ok(())
}

fn telegram_api_post(
    token: &str,
    api_base_url: Option<&str>,
    method: &str,
    payload: &Value,
) -> Result<Value, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Telegram bot token is required.".into());
    }
    let base_url = api_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.telegram.org")
        .trim_end_matches('/');
    let url = format!("{}/bot{}/{}", base_url, token, method);
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Unable to create Telegram HTTP client: {error}"))?;
    let response = client
        .post(url)
        .json(payload)
        .send()
        .map_err(|error| format!("Unable to reach Telegram API: {error}"))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .map_err(|error| format!("Unable to parse Telegram API response: {error}"))?;
    if !status.is_success() || value.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(
            value
                .get("description")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("Telegram API {} failed with status {}", method, status)),
        );
    }
    Ok(value)
}

fn json_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .map(value_to_string)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("Telegram response is missing {}", key))
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        _ => String::new(),
    }
}

fn telegram_chat_title(chat: &Value) -> String {
    chat.get("title")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            let first = chat.get("first_name").and_then(Value::as_str).unwrap_or("");
            let last = chat.get("last_name").and_then(Value::as_str).unwrap_or("");
            let combined = format!("{} {}", first, last).trim().to_string();
            if combined.is_empty() { None } else { Some(combined) }
        })
        .or_else(|| chat.get("username").and_then(Value::as_str).map(ToOwned::to_owned))
        .unwrap_or_else(|| "Telegram chat".into())
}

fn unix_timestamp_iso(timestamp: i64) -> String {
    chrono::DateTime::<Utc>::from_timestamp(timestamp, 0)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(now_iso)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::{resolve_channel_dispatch_plan, ChannelDispatchPlan};

    #[test]
    fn dispatches_immediately_when_session_is_idle() {
        assert_eq!(resolve_channel_dispatch_plan(false, false), ChannelDispatchPlan::DispatchNow);
    }

    #[test]
    fn waits_when_supervisor_runtime_is_still_processing() {
        assert_eq!(resolve_channel_dispatch_plan(true, true), ChannelDispatchPlan::WaitForActiveRun);
        assert_eq!(resolve_channel_dispatch_plan(false, true), ChannelDispatchPlan::WaitForActiveRun);
    }

    #[test]
    fn clears_stale_running_state_before_reusing_idle_session() {
        assert_eq!(resolve_channel_dispatch_plan(true, false), ChannelDispatchPlan::RecoverStaleRunState);
    }
}
