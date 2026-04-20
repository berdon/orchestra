use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{TaskAttachment, TaskAttachmentInput},
    services::orchestra_paths::{default_orchestra_root, task_attachments_dir},
};

const DEFAULT_PROJECT_ID: &str = "orchestra";
const MAX_TEXT_PREVIEW_BYTES: usize = 64 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: usize = 512 * 1024;

pub fn add_task_attachment(
    connection: &mut Connection,
    task_id: &str,
    input: TaskAttachmentInput,
) -> Result<TaskAttachment, String> {
    let project_id = task_project_id(connection, task_id)?;
    let attachment_id = attachment_id();
    let orchestra_root = default_orchestra_root()?;
    let attachment_dir = task_attachments_dir(&orchestra_root, &project_id, task_id);
    fs::create_dir_all(&attachment_dir).map_err(|error| {
        format!(
            "Unable to create task attachment directory {}: {error}",
            attachment_dir.display()
        )
    })?;

    let file_name = sanitize_file_name(&input.file_name);
    let stored_path = attachment_dir.join(format!("{}-{}", attachment_id, file_name));
    let bytes = STANDARD
        .decode(input.base64_data.as_bytes())
        .map_err(|error| format!("Unable to decode attachment payload: {error}"))?;
    fs::write(&stored_path, &bytes).map_err(|error| {
        format!(
            "Unable to write attachment {}: {error}",
            stored_path.display()
        )
    })?;

    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start attachment transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO task_attachments (
            id,
            project_id,
            task_id,
            file_name,
            media_type,
            byte_size,
            stored_path,
            caption,
            created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            attachment_id,
            project_id,
            task_id,
            file_name,
            normalized_media_type(&input.media_type),
            bytes.len() as i64,
            stored_path.display().to_string(),
            normalized_optional_string(input.caption),
            now,
        ],
    )
    .map_err(|error| format!("Unable to record task attachment: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task attachment: {error}"))?;

    load_attachment(connection, &attachment_id)
}

pub fn remove_task_attachment(
    connection: &Connection,
    attachment_id: &str,
) -> Result<TaskAttachment, String> {
    let attachment = load_attachment(connection, attachment_id)?;

    let deleted = connection
        .execute(
            "DELETE FROM task_attachments WHERE id = ?1",
            [attachment_id],
        )
        .map_err(|error| format!("Unable to delete task attachment {attachment_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task attachment {attachment_id} was not found"));
    }

    let path = PathBuf::from(&attachment.stored_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Unable to remove task attachment file {}: {error}",
                path.display()
            )
        })?;
    }

    Ok(attachment)
}

pub fn load_task_attachments(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskAttachment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at
            FROM task_attachments
            WHERE task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task attachment query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| format!("Unable to read task attachments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task attachments for {task_id}: {error}"))?
        .into_iter()
        .map(
            |(id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at)| {
                build_attachment(
                    id,
                    task_id,
                    file_name,
                    media_type,
                    byte_size,
                    stored_path,
                    caption,
                    created_at,
                )
            },
        )
        .collect()
}

pub fn load_attachment(
    connection: &Connection,
    attachment_id: &str,
) -> Result<TaskAttachment, String> {
    let row = connection
        .query_row(
            r#"
            SELECT id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at
            FROM task_attachments
            WHERE id = ?1
            "#,
            [attachment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task attachment {attachment_id}: {error}"))?
        .ok_or_else(|| format!("Task attachment {attachment_id} was not found"))?;

    build_attachment(row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7)
}

fn build_attachment(
    id: String,
    task_id: String,
    file_name: String,
    media_type: String,
    byte_size: i64,
    stored_path: String,
    caption: Option<String>,
    created_at: String,
) -> Result<TaskAttachment, String> {
    let path = Path::new(&stored_path);
    let mut preview_text = None;
    let mut image_data_url = None;

    if path.exists() {
        let bytes = fs::read(path).map_err(|error| {
            format!("Unable to read task attachment {}: {error}", path.display())
        })?;

        if is_text_media_type(&media_type) && bytes.len() <= MAX_TEXT_PREVIEW_BYTES {
            preview_text = Some(String::from_utf8_lossy(&bytes).to_string());
        }

        if is_image_media_type(&media_type) && bytes.len() <= MAX_IMAGE_PREVIEW_BYTES {
            image_data_url = Some(format!(
                "data:{};base64,{}",
                media_type,
                STANDARD.encode(bytes)
            ));
        }
    }

    Ok(TaskAttachment {
        id,
        task_id,
        file_name,
        media_type,
        byte_size,
        stored_path,
        caption,
        preview_text,
        image_data_url,
        created_at,
    })
}

fn task_project_id(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to resolve project for task {task_id}: {error}"))
}

fn is_text_media_type(media_type: &str) -> bool {
    media_type.starts_with("text/") || media_type == "application/json"
}

fn is_image_media_type(media_type: &str) -> bool {
    media_type.starts_with("image/")
}

fn normalized_media_type(media_type: &str) -> String {
    let trimmed = media_type.trim();
    if trimmed.is_empty() {
        "application/octet-stream".into()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let safe = trimmed
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '-',
            _ => ch,
        })
        .collect::<String>();
    if safe.is_empty() {
        "attachment.bin".into()
    } else {
        safe
    }
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn attachment_id() -> String {
    format!("task-attachment-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;
    use std::{fs, path::PathBuf};

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn create_task_record(connection: &mut Connection) -> String {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, task_type, status, priority, assignee_type, archived, created_at, updated_at) VALUES (?1, 'orchestra', 1, 'ORC-1', 'Task', 'task', 'ready', 'P2', 'user', 0, ?2, ?2)",
                params!["task-1", now],
            )
            .expect("insert task");
        "task-1".into()
    }

    #[test]
    fn stores_attachment_metadata_and_preview() {
        let mut connection = in_memory_connection();
        let task_id = create_task_record(&mut connection);
        let root = default_orchestra_root().expect("orchestra root");
        let attachment_dir = task_attachments_dir(&root, DEFAULT_PROJECT_ID, &task_id);
        if attachment_dir.exists() {
            fs::remove_dir_all(&attachment_dir).ok();
        }

        let attachment = add_task_attachment(
            &mut connection,
            &task_id,
            TaskAttachmentInput {
                file_name: "notes.txt".into(),
                media_type: "text/plain".into(),
                base64_data: STANDARD.encode("hello attachments"),
                caption: Some("Spec notes".into()),
            },
        )
        .expect("add attachment");

        assert_eq!(attachment.file_name, "notes.txt");
        assert_eq!(
            attachment.preview_text.as_deref(),
            Some("hello attachments")
        );
        assert!(PathBuf::from(&attachment.stored_path).exists());

        let attachments = load_task_attachments(&connection, &task_id).expect("load attachments");
        assert_eq!(attachments.len(), 1);
        let removed =
            remove_task_attachment(&connection, &attachment.id).expect("remove attachment");
        assert_eq!(removed.id, attachment.id);
        assert!(!PathBuf::from(&removed.stored_path).exists());
    }
}
