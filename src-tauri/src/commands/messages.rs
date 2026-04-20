use tauri::{AppHandle, State};

use crate::{
    models::{
        ArchiveMailboxMessagesInput, MailboxMessage, MarkMailboxMessagesReadInput,
        SendMailboxMessageInput,
    },
    services::{app_events, database, messages},
    state::AppState,
};

#[tauri::command]
pub fn list_inbox_messages(
    project_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<MailboxMessage>, String> {
    let connection = database::open_connection()?;
    messages::list_user_messages(
        &connection,
        project_id.as_deref(),
        include_archived.unwrap_or(false),
    )
}

#[tauri::command]
pub fn list_task_messages(task_id: String) -> Result<Vec<MailboxMessage>, String> {
    let connection = database::open_connection()?;
    messages::list_task_messages(&connection, &task_id)
}

#[tauri::command]
pub fn send_mailbox_message(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SendMailboxMessageInput,
) -> Result<MailboxMessage, String> {
    let connection = database::open_connection()?;
    let message =
        messages::send_mailbox_message_from_user(app.clone(), &state, &connection, input)?;
    state.log(
        "info",
        "mailbox.sent",
        &format!(
            "Sent mailbox delivery {} to {}",
            message.delivery_id, message.recipient_label
        ),
    );
    let _ = app_events::emit_inbox_change(&app, "mailbox.sent", [message.delivery_id.clone()]);
    if let Some(task_id) = message.task_id.clone() {
        let _ = app_events::emit_task_change(&app, "mailbox.sent", [task_id]);
    }
    Ok(message)
}

#[tauri::command]
pub fn mark_mailbox_messages_read(
    app: AppHandle,
    state: State<'_, AppState>,
    input: MarkMailboxMessagesReadInput,
) -> Result<Vec<MailboxMessage>, String> {
    let connection = database::open_connection()?;
    let messages = messages::mark_user_messages_read(&connection, input.delivery_ids.as_deref())?;
    if !messages.is_empty() {
        state.log(
            "info",
            "mailbox.read",
            &format!("Marked {} mailbox deliveries read", messages.len()),
        );
        let _ = app_events::emit_inbox_change(
            &app,
            "mailbox.read",
            messages.iter().map(|message| message.delivery_id.clone()),
        );
    }
    Ok(messages)
}

#[tauri::command]
pub fn archive_mailbox_messages(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ArchiveMailboxMessagesInput,
) -> Result<Vec<MailboxMessage>, String> {
    let connection = database::open_connection()?;
    let messages = messages::archive_user_messages(&connection, input.delivery_ids.as_deref())?;
    if !messages.is_empty() {
        state.log(
            "info",
            "mailbox.archived",
            &format!("Archived {} mailbox deliveries", messages.len()),
        );
        let _ = app_events::emit_inbox_change(
            &app,
            "mailbox.archived",
            messages.iter().map(|message| message.delivery_id.clone()),
        );
    }
    Ok(messages)
}
